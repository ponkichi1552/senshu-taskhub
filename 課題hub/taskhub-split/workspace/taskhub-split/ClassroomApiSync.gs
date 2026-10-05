/**
 * Fetches a complete, paginated snapshot before touching the saved workbook.
 * A failure in any course leaves the previous API-backed task rows intact.
 */
function syncClassroomApiCourseworkToSpreadsheet_(options) {
  const syncOptions = options && typeof options === 'object' ? options : {};
  const fetchedAt = syncOptions.referenceNow instanceof Date && !Number.isNaN(syncOptions.referenceNow.getTime())
    ? new Date(syncOptions.referenceNow)
    : new Date();
  const applyRetention = syncOptions.applyRetention === true;

  try {
    const courses = listClassroomApiExperimentCourses_();
    const coursework = [];
    const courseData = [];
    let returnedCourseworkCount = 0;
    let excludedUnassignedCourseworkCount = 0;
    const resolveCurrentStudentId = createClassroomApiCurrentStudentResolver_();

    courses.forEach(course => {
      if (!course || !course.id) throw new Error('授業IDがありません。');
      const courseId = String(course.id || '');
      const courseName = String(course.name || '(授業名なし)');
      let teachers;
      let topics;
      try {
        teachers = listClassroomApiExperimentTeachers_(courseId)
          .map(teacher => getClassroomApiExperimentTeacherName_(teacher))
          .filter(Boolean);
      } catch (error) {
        throw new Error(`「${courseName}」の教員情報を取得できませんでした: ${getClassroomApiExperimentErrorMessage_(error)}`);
      }
      try {
        topics = listClassroomApiExperimentTopics_(courseId);
      } catch (error) {
        throw new Error(`「${courseName}」のトピック情報を取得できませんでした: ${getClassroomApiExperimentErrorMessage_(error)}`);
      }
      const topicNames = {};
      topics.forEach(topic => {
        if (topic && topic.topicId) topicNames[String(topic.topicId)] = String(topic.name || topic.topicId);
      });
      courseData.push({course, courseId, courseName, teachers});

      let items;
      try {
        items = listClassroomApiExperimentCoursework_(courseId);
      } catch (error) {
        throw new Error(`「${courseName}」の課題を取得できませんでした: ${getClassroomApiExperimentErrorMessage_(error)}`);
      }

      items.forEach(item => {
        if (!item || !item.id) throw new Error(`「${courseName}」の課題IDがありません。`);
        returnedCourseworkCount++;
        const record = {
          courseId,
          courseName,
          courseState: String(course.courseState || 'ACTIVE'),
          course,
          teachers,
          topicNames,
          item
        };
        if (isClassroomApiCourseworkAssignedToCurrentStudent_(item, resolveCurrentStudentId)) {
          let submissions;
          try {
            submissions = listClassroomApiExperimentStudentSubmissions_(courseId, String(item.id || ''));
          } catch (error) {
            throw new Error(`「${courseName}」の提出状況を取得できませんでした: ${getClassroomApiExperimentErrorMessage_(error)}`);
          }
          record.submission = selectClassroomApiExperimentCurrentStudentSubmission_(submissions, resolveCurrentStudentId());
          coursework.push(record);
        } else {
          excludedUnassignedCourseworkCount++;
        }
      });
    });

    return runWithUserLock_('Classroom API課題保存', () => {
      const ss = getOrCreateSpreadsheetLocked_();
      const notificationSheets = ensureNotificationStorageLocked_(ss);
      const structuredSheets = ensureClassroomStructuredStorageLocked_(ss);
      const previousCourseRows = getStructuredSheetRows_(structuredSheets.courses, CLASSROOM_COURSE_HEADERS.length);
      const existingTaskRows = getStructuredSheetRows_(structuredSheets.coursework, CLASSROOM_COURSEWORK_HEADERS.length);
      const previousSubmissionRows = getStructuredSheetRows_(structuredSheets.submissions, CLASSROOM_SUBMISSION_HEADERS.length);
      const supplementSheet = notificationSheets['Google Classroom'];
      const existingSupplementRows = supplementSheet.getLastRow() >= 2
        ? supplementSheet.getRange(2, 1, supplementSheet.getLastRow() - 1, HEADER_ROW.length).getValues()
        : [];
      const courseIdColumn = getClassroomCourseworkColumn_('授業ID');
      const courseworkIdColumn = getClassroomCourseworkColumn_('課題ID');
      const apiRowsById = new Map();
      existingTaskRows.forEach(row => apiRowsById.set(
        getClassroomCourseworkKey_(row[courseIdColumn], row[courseworkIdColumn]),
        row
      ));

      const courseworkToPersist = applyRetention
        ? coursework.filter(record => {
            const priorRow = apiRowsById.get(getClassroomCourseworkKey_(record.courseId, record.item.id)) || null;
            return !isClassroomApiCourseworkExpiredForRetention_(record.item, fetchedAt, priorRow);
          })
        : coursework;
      const removedExpiredCourseworkCount = coursework.length - courseworkToPersist.length;

      const apiRows = courseworkToPersist.map(record => {
        const priorApiRow = apiRowsById.get(getClassroomCourseworkKey_(record.courseId, record.item.id)) || null;
        const previousState = chooseClassroomApiRecordState_(priorApiRow, record.submission);
        return buildClassroomApiCourseworkStorageRow_(record, fetchedAt, previousState);
      });

      const courseRows = courseData.map(({course, courseId, courseName, teachers}) => [
        courseId,
        courseName,
        String(course.section || ''),
        teachers.join('、'),
        String(course.alternateLink || ''),
        String(course.courseState || 'ACTIVE'),
        fetchedAt
      ]);
      const submissionRows = courseworkToPersist
        .filter(record => record.submission)
        .map(record => buildClassroomApiSubmissionStorageRow_(record, fetchedAt));

      const userProperties = PropertiesService.getUserProperties();
      const priorWriteWasIncomplete = userProperties.getProperty(CLASSROOM_API_STRUCTURED_SYNC_IN_PROGRESS_PROPERTY) === 'true';
      userProperties.setProperty(CLASSROOM_API_STRUCTURED_SYNC_IN_PROGRESS_PROPERTY, 'true');
      let retainedAssignmentEmailCount = 0;
      try {
        replaceStructuredSheetRows_(structuredSheets.courses, CLASSROOM_COURSE_HEADERS, courseRows);
        replaceStructuredSheetRows_(structuredSheets.coursework, CLASSROOM_COURSEWORK_HEADERS, apiRows);
        replaceStructuredSheetRows_(structuredSheets.submissions, CLASSROOM_SUBMISSION_HEADERS, submissionRows);

        // Gmail runs more frequently than the Classroom API. Preserve every
        // Gmail event as source data; the read path joins matching assignment
        // emails onto their API task and leaves unmatched emails visible.
        const retainedSupplementRows = existingSupplementRows;
        retainedAssignmentEmailCount = retainedSupplementRows.filter(isClassroomAssignmentEmailRow_).length;
        const supplementConfig = getNotificationStorageConfigForSource_('Google Classroom');
        replaceNotificationSheetRows_(supplementSheet, normalizeNotificationRowsForStorage_(retainedSupplementRows, supplementConfig));
        SpreadsheetApp.flush();
      } catch (writeError) {
        try {
          replaceStructuredSheetRows_(structuredSheets.courses, CLASSROOM_COURSE_HEADERS, previousCourseRows);
          replaceStructuredSheetRows_(structuredSheets.coursework, CLASSROOM_COURSEWORK_HEADERS, existingTaskRows);
          replaceStructuredSheetRows_(structuredSheets.submissions, CLASSROOM_SUBMISSION_HEADERS, previousSubmissionRows);
          replaceNotificationSheetRows_(supplementSheet, existingSupplementRows);
          SpreadsheetApp.flush();
          if (!priorWriteWasIncomplete) {
            userProperties.deleteProperty(CLASSROOM_API_STRUCTURED_SYNC_IN_PROGRESS_PROPERTY);
          }
        } catch (rollbackError) {
          throw new Error(
            `Classroom APIのシート更新に失敗し、前回データへの復旧も完了できませんでした。更新エラー: ${getClassroomApiExperimentErrorMessage_(writeError)} / 復旧エラー: ${getClassroomApiExperimentErrorMessage_(rollbackError)}`
          );
        }
        throw writeError;
      }

      userProperties.setProperty(CLASSROOM_API_LAST_SUCCESS_PROPERTY, fetchedAt.toISOString());
      userProperties.setProperty(CLASSROOM_API_STRUCTURED_SYNC_PROPERTY, fetchedAt.toISOString());
      userProperties.deleteProperty(CLASSROOM_API_LAST_ERROR_PROPERTY);
      userProperties.deleteProperty(CLASSROOM_API_STRUCTURED_SYNC_IN_PROGRESS_PROPERTY);
      SpreadsheetApp.flush();

      const submissionStateCounts = {};
      submissionRows.forEach(row => {
        const submissionState = String(row[4] || 'UNKNOWN').toUpperCase();
        submissionStateCounts[submissionState] = (submissionStateCounts[submissionState] || 0) + 1;
      });
      const courseworkStatusRows = getClassroomApiNotificationRowsForWeb_();

      return {
        courseCount: courses.length,
        courseworkCount: courseworkToPersist.length,
        fetchedCourseworkCount: returnedCourseworkCount,
        excludedUnassignedCourseworkCount,
        removedExpiredCourseworkCount,
        applyRetention,
        retainedAssignmentEmailCount,
        completedCourseworkCount: courseworkStatusRows.filter(row => row[12] === '完了').length,
        submittedCourseworkCount: submissionRows.filter(row => ['TURNED_IN', 'RETURNED', 'STUDENT_EDITED_AFTER_TURN_IN'].includes(String(row[4] || '').toUpperCase())).length,
        submissionStateCounts,
        courseworkStatuses: courseworkStatusRows.map(row => ({
          courseName: String(row[3] || ''),
          title: String(row[4] || ''),
          due: String(row[5] || ''),
          status: String(row[12] || ''),
          submissionState: String(row[15] || '')
        })),
        fetchedAt: fetchedAt.toISOString()
      };
    });
  } catch (error) {
    recordClassroomApiSyncError_(error);
    throw error;
  }
}

/** Save the Classroom API snapshot without running Gmail synchronization. */
function syncClassroomApiOnlyForExperimentWeb() {
  try {
    return {
      ok: true,
      gmailCalled: false,
      result: syncClassroomApiCourseworkToSpreadsheet_()
    };
  } catch (error) {
    return {
      ok: false,
      gmailCalled: false,
      message: getClassroomApiExperimentErrorMessage_(error)
    };
  }
}

function buildClassroomApiNotificationRow_(record, fetchedAt, previousState, priorApiRow) {
  const item = record.item || {};
  const due = getClassroomApiLocalDuePartsForExperiment_(item);
  const dueDate = due.dueDate;
  const dueTime = due.dueTime;
  const dueValue = dueDate ? `${dueDate}${dueTime ? ` ${dueTime}` : ''}` : '期限なし';
  const receivedAt = getClassroomApiCourseworkDeliveryDate_(item, priorApiRow, fetchedAt);
  const link = String(item.alternateLink || '');
  const description = String(item.description || '').slice(0, CONFIG.BODY_LIMIT);
  const body = [description, link].filter(Boolean).join('\n\n');
  const status = previousState && previousState.status === '完了' ? '完了' : '未確認';
  const completedAt = status === '完了' ? previousState.completedAt || '' : '';
  const submissionState = previousState && previousState.submissionState || '';
  const stateSource = previousState && previousState.stateSource || '';

  return toSafeSpreadsheetRow_([
    fetchedAt,
    buildClassroomApiMessageId_(record.courseId, item.id),
    'Google Classroom',
    record.courseName,
    String(item.title || '(課題名なし)'),
    dueValue,
    dueDate ? 'Classroom API' : (due.dueTimeSource ? `期限未検出（${due.dueTimeSource}）` : '期限なし（Classroom API）'),
    String(item.title || '(課題名なし)'),
    'Google Classroom API',
    receivedAt,
    link,
    body,
    status,
    completedAt,
    stateSource,
    submissionState,
    ''
  ]);
}

function buildClassroomApiCourseworkStorageRow_(record, fetchedAt, previousState) {
  const item = record.item || {};
  const due = getClassroomApiLocalDuePartsForExperiment_(item);
  const materialLinks = getClassroomApiExperimentMaterialLinks_(item.materials);
  const state = previousState || {status: '未確認', completedAt: '', stateSource: 'classroom-api-submission'};
  return [
    record.courseId,
    String(item.id || ''),
    record.courseName,
    String(item.title || '(課題名なし)'),
    String(item.description || '').slice(0, CONFIG.BODY_LIMIT),
    String(item.workType || ''),
    String(item.assigneeMode || 'ALL_STUDENTS'),
    JSON.stringify(materialLinks),
    String(item.topicId || ''),
    item.topicId ? String(record.topicNames[String(item.topicId)] || '') : '',
    String(item.scheduledTime || ''),
    String(item.creationTime || ''),
    String(item.updateTime || ''),
    due.dueDate,
    due.dueTime,
    due.dueTimeSource,
    String(item.alternateLink || ''),
    fetchedAt,
    String(state.status || '未確認'),
    state.completedAt || '',
    String(state.stateSource || 'classroom-api-submission')
  ];
}

function buildClassroomApiSubmissionStorageRow_(record, fetchedAt) {
  const submission = record.submission || {};
  const state = String(submission.state || 'UNKNOWN').toUpperCase();
  const submittedAt = getClassroomApiExperimentSubmittedAt_(submission) ||
    (['TURNED_IN', 'RETURNED', 'STUDENT_EDITED_AFTER_TURN_IN'].includes(state) ? String(submission.updateTime || '') : '');
  return [
    record.courseId,
    String(record.item.id || ''),
    record.courseName,
    String(record.item.title || '(課題名なし)'),
    state,
    submittedAt,
    submission.late === true,
    state === 'RETURNED',
    submission.assignedGrade === undefined ? '' : submission.assignedGrade,
    String(submission.updateTime || fetchedAt.toISOString())
  ];
}

function replaceNotificationSheetRows_(sheet, rows) {
  const currentDataRowCount = Math.max(0, sheet.getLastRow() - 1);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, HEADER_ROW.length).setValues(rows);
  }
  if (currentDataRowCount > rows.length) {
    sheet.getRange(rows.length + 2, 1, currentDataRowCount - rows.length, HEADER_ROW.length).clearContent();
  }
}

function buildClassroomApiMessageId_(courseId, courseworkId) {
  return `classroom-api:${String(courseId || '').trim()}:${String(courseworkId || '').trim()}`;
}

function getClassroomApiCourseworkDeliveryDate_(item, priorApiRow, fallbackDate) {
  const priorStructuredRow = Array.isArray(priorApiRow) && priorApiRow.length === CLASSROOM_COURSEWORK_HEADERS.length;
  const priorDeliveryCandidates = priorStructuredRow
    ? [
        priorApiRow[getClassroomCourseworkColumn_('公開日時')],
        priorApiRow[getClassroomCourseworkColumn_('作成日時')],
        priorApiRow[getClassroomCourseworkColumn_('最終取得日時')]
      ]
    : [priorApiRow && priorApiRow[9]];
  const candidates = [
    item && item.scheduledTime,
    item && item.creationTime,
    ...priorDeliveryCandidates,
    item && item.updateTime,
    fallbackDate
  ];
  for (const candidate of candidates) {
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) return new Date(candidate);
    if (candidate) {
      const date = new Date(candidate);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return new Date();
}

function getClassroomApiCourseworkDeadlineForRetention_(item) {
  if (!item || !item.dueDate) return null;
  const localDue = getClassroomApiLocalDuePartsForExperiment_(item);
  const dateMatch = String(localDue.dueDate || '').match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const timeMatch = String(localDue.dueTime || '').match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (!isValidClassroomApiDatePartsForExperiment_(year, month, day) || hour > 23 || minute > 59) return null;
  // Convert normalized Japan wall time to the UTC instant used by Date.
  const localDeadline = new Date(0);
  localDeadline.setUTCFullYear(year, month - 1, day);
  localDeadline.setUTCHours(hour, minute, 59, 999);
  return localDeadline.getTime() - 9 * 60 * 60 * 1000;
}

function isClassroomApiCourseworkExpiredForRetention_(item, referenceNow, priorApiRow) {
  const now = referenceNow instanceof Date && !Number.isNaN(referenceNow.getTime()) ? referenceNow.getTime() : Date.now();
  const deadline = getClassroomApiCourseworkDeadlineForRetention_(item);
  // A malformed supplied deadline is not the same as a task with no deadline;
  // keep it until the source data can be interpreted safely.
  if (item && item.dueDate && deadline === null) return false;
  if (deadline !== null) return now > deadline + 14 * 24 * 60 * 60 * 1000;
  const deliveredAt = getClassroomApiCourseworkDeliveryDate_(item, priorApiRow, referenceNow || new Date()).getTime();
  return now > deliveredAt + 21 * 24 * 60 * 60 * 1000;
}

function isNotYetPublishedClassroomApiNotificationForWeb_(item, referenceNow) {
  if (!item || !String(item.messageId || '').startsWith('classroom-api:')) return false;
  if (!Number.isFinite(Number(item.receivedAtTime)) || Number(item.receivedAtTime) <= 0) return false;
  const now = referenceNow instanceof Date ? referenceNow.getTime() : Date.now();
  return Number(item.receivedAtTime) > now;
}

function hasClassroomApiSuccessfulSnapshot_() {
  return Boolean(PropertiesService.getUserProperties().getProperty(CLASSROOM_API_LAST_SUCCESS_PROPERTY));
}

function shouldSkipClassroomAssignmentMail_(source, body) {
  // Kept as a compatibility predicate for older callers. Gmail is the quick
  // first-pass source even after API sync has succeeded.
  return false;
}

function isClassroomApiManagedRow_(row) {
  return Boolean(row) && String(row[1] || '').startsWith('classroom-api:');
}

function isClassroomAssignmentEmailRow_(row) {
  return Boolean(row) &&
    String(row[2] || '') === 'Google Classroom' &&
    !isClassroomApiManagedRow_(row) &&
    !isClassroomExtensionSyncRow_(row) &&
    getClassroomNotificationType_(row[11]) === 'newAssignment';
}

function chooseClassroomApiRecordState_(priorApiRow, submission) {
  const submissionState = String(submission && submission.state || '').toUpperCase();
  const priorStructuredRow = Array.isArray(priorApiRow) && priorApiRow.length === CLASSROOM_COURSEWORK_HEADERS.length;
  const priorStatus = String(priorApiRow && priorApiRow[priorStructuredRow
    ? getClassroomCourseworkColumn_('TaskHub確認状態')
    : 12] || '');
  const priorStatusSource = String(priorApiRow && priorApiRow[priorStructuredRow
    ? getClassroomCourseworkColumn_('状態更新元')
    : 14] || '');
  const isManualCompletion = priorStatus === '完了' && priorStatusSource === 'manual-status';

  if (isManualCompletion) {
    return {
      status: '完了',
      completedAt: priorApiRow[priorStructuredRow ? getClassroomCourseworkColumn_('TaskHub完了日時') : 13] || '',
      stateSource: 'manual-status',
      submissionState
    };
  }

  if (submissionState === 'TURNED_IN' || submissionState === 'RETURNED' || submissionState === 'STUDENT_EDITED_AFTER_TURN_IN') {
    const apiSubmittedAt = getClassroomApiExperimentSubmittedAt_(submission) ||
      String(submission && submission.updateTime || '') || priorApiRow && priorApiRow[13] || '';
    return {status: '完了', completedAt: apiSubmittedAt, stateSource: 'classroom-api-submission', submissionState};
  }

  // Submission state is authoritative over Gmail's completion notices and
  // any API-derived completion that is no longer present in this snapshot.
  return {status: '未確認', completedAt: '', stateSource: 'classroom-api-submission', submissionState};
}

function recordClassroomApiSyncError_(error) {
  try {
    PropertiesService.getUserProperties().setProperty(CLASSROOM_API_LAST_ERROR_PROPERTY, JSON.stringify({
      at: new Date().toISOString(),
      message: getClassroomApiExperimentErrorMessage_(error)
    }));
  } catch (_) {
    // Keep the original API error as the primary failure.
  }
}

function syncClassroomApiCourseworkOnSchedule_(referenceNow) {
  const options = {applyRetention: true};
  if (referenceNow instanceof Date && !Number.isNaN(referenceNow.getTime())) options.referenceNow = referenceNow;
  return syncClassroomApiCourseworkToSpreadsheet_(options);
}

function ensureClassroomApiTrigger_() {
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === CLASSROOM_API_TRIGGER_HANDLER);
  const props = PropertiesService.getUserProperties();
  const configuredRevision = props.getProperty(CLASSROOM_API_TRIGGER_REVISION_PROPERTY);

  if (matchingTriggers.length > 0 && configuredRevision === CLASSROOM_API_TRIGGER_REVISION) {
    matchingTriggers.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));
    return {created: false, removedDuplicates: Math.max(0, matchingTriggers.length - 1)};
  }

  const replacement = ScriptApp.newTrigger(CLASSROOM_API_TRIGGER_HANDLER)
    .timeBased()
    .everyHours(1)
    .create();
  matchingTriggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  props.setProperty(CLASSROOM_API_TRIGGER_REVISION_PROPERTY, CLASSROOM_API_TRIGGER_REVISION);

  return {
    created: true,
    removedDuplicates: Math.max(0, matchingTriggers.length - 1),
    replacementId: replacement.getUniqueId ? replacement.getUniqueId() : ''
  };
}

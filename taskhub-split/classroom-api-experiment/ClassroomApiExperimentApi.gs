/**
 * Read-only Classroom API probe for the isolated experiment project.
 * Results are returned to the caller and are never written to a spreadsheet.
 */
function createClassroomApiCurrentStudentResolver_() {
  let resolved = false;
  let studentId = '';
  return function() {
    if (resolved) return studentId;
    const profile = Classroom.UserProfiles.get('me') || {};
    studentId = String(profile.id || profile.userId || '').trim();
    if (!studentId) throw new Error('現在のClassroom利用者IDを取得できないため、個人指定課題を安全に判定できません。');
    resolved = true;
    return studentId;
  };
}

function isClassroomApiCourseworkAssignedToCurrentStudent_(item, resolveCurrentStudentId) {
  if (String(item && item.assigneeMode || '').toUpperCase() !== 'INDIVIDUAL_STUDENTS') return true;
  const studentIds = item && item.individualStudentsOptions && item.individualStudentsOptions.studentIds;
  if (!Array.isArray(studentIds) || studentIds.length === 0) return false;
  const currentStudentId = typeof resolveCurrentStudentId === 'function' ? resolveCurrentStudentId() : '';
  if (!currentStudentId) throw new Error('Classroom利用者IDが空のため、個人指定課題を安全に判定できません。');
  return studentIds.some(id => String(id || '').trim() === currentStudentId);
}

function getClassroomApiExperimentPreviewForWeb() {
  const startedAt = Date.now();
  try {
    const courses = listClassroomApiExperimentCourses_();
    const coursework = [];
    const courseErrors = [];
    const resolveCurrentStudentId = createClassroomApiCurrentStudentResolver_();

    courses.forEach(course => {
      try {
        listClassroomApiExperimentCoursework_(course.id).forEach(item => {
          if (!isClassroomApiCourseworkAssignedToCurrentStudent_(item, resolveCurrentStudentId)) return;
          coursework.push({
            courseName: String(course.name || '(授業名なし)'),
            courseId: String(course.id || ''),
            title: String(item.title || '(課題名なし)'),
            state: String(item.state || ''),
            assigneeMode: String(item.assigneeMode || ''),
            scheduledTime: String(item.scheduledTime || ''),
            creationTime: String(item.creationTime || ''),
            dueDate: getClassroomApiLocalDuePartsForExperiment_(item).dueDate,
            dueTime: getClassroomApiLocalDuePartsForExperiment_(item).dueTime,
            apiDueDateUtc: formatClassroomApiDateForExperiment_(item.dueDate),
            apiDueTimeUtc: formatClassroomApiTimeForExperiment_(item.dueTime),
            updateTime: String(item.updateTime || ''),
            alternateLink: String(item.alternateLink || '')
          });
        });
      } catch (error) {
        courseErrors.push({
          courseName: String(course.name || '(授業名なし)'),
          message: getClassroomApiExperimentErrorMessage_(error)
        });
      }
    });

    coursework.sort((left, right) => {
      const leftDue = left.dueDate ? `${left.dueDate} ${left.dueTime || '23:59'}` : '9999/99/99 99:99';
      const rightDue = right.dueDate ? `${right.dueDate} ${right.dueTime || '23:59'}` : '9999/99/99 99:99';
      return leftDue.localeCompare(rightDue, 'ja');
    });

    return {
      ok: true,
      provider: 'Google Classroom API v1',
      courseCount: courses.length,
      courseworkCount: coursework.length,
      courses: courses.map(course => ({
        id: String(course.id || ''),
        name: String(course.name || '(授業名なし)'),
        section: String(course.section || ''),
        state: String(course.courseState || '')
      })),
      coursework: coursework.slice(0, 300),
      omittedCount: Math.max(0, coursework.length - 300),
      courseErrors,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      readOnly: true,
      savedToSpreadsheet: false
    };
  } catch (error) {
    return {
      ok: false,
      provider: 'Google Classroom API v1',
      message: getClassroomApiExperimentErrorMessage_(error),
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      readOnly: true,
      savedToSpreadsheet: false
    };
  }
}

/**
 * Read-only export for the five-sheet workbook. This deliberately returns only
 * course/task metadata and the signed-in student's submission metadata; it
 * never reads submission answers/files and never calls Gmail or Sheets.
 */
function getClassroomApiExperimentWorkbookDataForWeb() {
  const startedAt = Date.now();
  const fetchedAt = new Date().toISOString();
  try {
    const courses = listClassroomApiExperimentCourses_();
    const courseRows = [];
    const courseworkRows = [];
    const submissionRows = [];
    const errors = [];
    const resolveCurrentStudentId = createClassroomApiCurrentStudentResolver_();
    let excludedUnassignedCourseworkCount = 0;

    courses.forEach(course => {
      const courseId = String(course.id || '');
      if (!courseId) return;

      let teacherNames = [];
      try {
        teacherNames = listClassroomApiExperimentTeachers_(courseId)
          .map(teacher => getClassroomApiExperimentTeacherName_(teacher))
          .filter(Boolean);
      } catch (error) {
        errors.push({courseName: String(course.name || courseId), section: '教員', message: getClassroomApiExperimentErrorMessage_(error)});
      }

      const topicNames = {};
      try {
        listClassroomApiExperimentTopics_(courseId).forEach(topic => {
          if (topic && topic.topicId) topicNames[String(topic.topicId)] = String(topic.name || topic.topicId);
        });
      } catch (error) {
        errors.push({courseName: String(course.name || courseId), section: 'トピック', message: getClassroomApiExperimentErrorMessage_(error)});
      }

      courseRows.push({
        id: courseId,
        name: String(course.name || '(授業名なし)'),
        section: String(course.section || ''),
        teacherNames: teacherNames,
        alternateLink: String(course.alternateLink || ''),
        state: String(course.courseState || '')
      });

      let items = [];
      try {
        items = listClassroomApiExperimentCoursework_(courseId);
      } catch (error) {
        errors.push({courseName: String(course.name || courseId), section: '課題', message: getClassroomApiExperimentErrorMessage_(error)});
        return;
      }

      items.forEach(item => {
        if (!isClassroomApiCourseworkAssignedToCurrentStudent_(item, resolveCurrentStudentId)) {
          excludedUnassignedCourseworkCount++;
          return;
        }
        const due = getClassroomApiLocalDuePartsForExperiment_(item);
        const dueDate = due.dueDate;
        const dueTime = due.dueTime;
        const materialLinks = getClassroomApiExperimentMaterialLinks_(item.materials);
        courseworkRows.push({
          courseId: courseId,
          courseName: String(course.name || '(授業名なし)'),
          id: String(item.id || ''),
          title: String(item.title || '(課題名なし)'),
          description: String(item.description || ''),
          workType: String(item.workType || ''),
          assigneeMode: String(item.assigneeMode || 'ALL_STUDENTS'),
          materialLinks: materialLinks,
          topicId: String(item.topicId || ''),
          topicName: item.topicId ? String(topicNames[String(item.topicId)] || '') : '',
          scheduledTime: String(item.scheduledTime || ''),
          creationTime: String(item.creationTime || ''),
          updateTime: String(item.updateTime || ''),
          dueDate: dueDate,
          dueTime: dueTime,
          dueTimeSource: dueDate ? due.dueTimeSource : '',
          apiDueDateUtc: formatClassroomApiDateForExperiment_(item.dueDate),
          apiDueTimeUtc: formatClassroomApiTimeForExperiment_(item.dueTime),
          alternateLink: String(item.alternateLink || ''),
          fetchedAt: fetchedAt
        });

        try {
          const submissions = listClassroomApiExperimentStudentSubmissions_(courseId, String(item.id || ''));
          const submission = selectClassroomApiExperimentCurrentStudentSubmission_(submissions, resolveCurrentStudentId());
          if (submission) {
            submissionRows.push({
              courseId: courseId,
              courseworkId: String(item.id || ''),
              courseName: String(course.name || '(授業名なし)'),
              courseworkTitle: String(item.title || '(課題名なし)'),
              state: String(submission.state || ''),
              submittedAt: getClassroomApiExperimentSubmittedAt_(submission),
              late: submission.late === true,
              returned: String(submission.state || '') === 'RETURNED',
              assignedGrade: submission.assignedGrade === undefined ? '' : submission.assignedGrade
            });
          }
        } catch (error) {
          errors.push({courseName: String(course.name || courseId), courseworkTitle: String(item.title || ''), section: '本人の提出状況', message: getClassroomApiExperimentErrorMessage_(error)});
        }
      });
    });

    courseworkRows.sort((left, right) => {
      const leftDue = left.dueDate ? `${left.dueDate} ${left.dueTime}` : '9999/99/99 99:99';
      const rightDue = right.dueDate ? `${right.dueDate} ${right.dueTime}` : '9999/99/99 99:99';
      return leftDue.localeCompare(rightDue, 'ja');
    });

    return {
      ok: true,
      provider: 'Google Classroom API v1',
      courses: courseRows,
      coursework: courseworkRows,
      submissions: submissionRows,
      courseCount: courseRows.length,
      courseworkCount: courseworkRows.length,
      excludedUnassignedCourseworkCount,
      submissionCount: submissionRows.length,
      errors: errors,
      fetchedAt: fetchedAt,
      elapsedMs: Date.now() - startedAt,
      readOnly: true,
      savedToSpreadsheet: false,
      gmailCalled: false,
      submissionAnswersIncluded: false,
      submissionFilesIncluded: false
    };
  } catch (error) {
    return {
      ok: false,
      provider: 'Google Classroom API v1',
      message: getClassroomApiExperimentErrorMessage_(error),
      fetchedAt: fetchedAt,
      elapsedMs: Date.now() - startedAt,
      readOnly: true,
      savedToSpreadsheet: false,
      gmailCalled: false
    };
  }
}

function listClassroomApiExperimentTeachers_(courseId) {
  const teachers = [];
  let pageToken = '';
  do {
    const request = {pageSize: 100};
    if (pageToken) request.pageToken = pageToken;
    const response = Classroom.Courses.Teachers.list(courseId, request) || {};
    (response.teachers || []).forEach(teacher => teachers.push(teacher));
    pageToken = String(response.nextPageToken || '');
  } while (pageToken);
  return teachers;
}

function listClassroomApiExperimentTopics_(courseId) {
  const topics = [];
  let pageToken = '';
  do {
    const request = {pageSize: 100};
    if (pageToken) request.pageToken = pageToken;
    const response = Classroom.Courses.Topics.list(courseId, request) || {};
    (response.topic || []).forEach(topic => topics.push(topic));
    pageToken = String(response.nextPageToken || '');
  } while (pageToken);
  return topics;
}

function listClassroomApiExperimentStudentSubmissions_(courseId, courseworkId) {
  const submissions = [];
  if (!courseId || !courseworkId) return submissions;
  let pageToken = '';
  do {
    const request = {
      userId: 'me',
      pageSize: 100,
      fields: 'nextPageToken,studentSubmissions(id,userId,state,late,assignedGrade,updateTime,submissionHistory(stateHistory(state,stateTimestamp)))'
    };
    if (pageToken) request.pageToken = pageToken;
    const response = Classroom.Courses.CourseWork.StudentSubmissions.list(courseId, courseworkId, request) || {};
    (response.studentSubmissions || []).forEach(submission => submissions.push(submission));
    pageToken = String(response.nextPageToken || '');
  } while (pageToken);
  return submissions;
}

function getClassroomApiExperimentTeacherName_(teacher) {
  const profile = teacher && teacher.profile ? teacher.profile : {};
  const name = profile.name || {};
  return String(name.fullName || [name.familyName, name.givenName].filter(Boolean).join(' ') || '');
}

function getClassroomApiExperimentMaterialLinks_(materials) {
  return (materials || []).map(material => {
    if (material.link && material.link.url) return String(material.link.url);
    if (material.driveFile && material.driveFile.driveFile) {
      const file = material.driveFile.driveFile;
      return String(file.alternateLink || file.title || '');
    }
    if (material.youtubeVideo && material.youtubeVideo.alternateLink) return String(material.youtubeVideo.alternateLink);
    if (material.form && material.form.formUrl) return String(material.form.formUrl);
    return '';
  }).filter(Boolean);
}

function getClassroomApiExperimentSubmittedAt_(submission) {
  const history = (submission && submission.submissionHistory) || [];
  const submittedStates = new Set(['TURNED_IN', 'STUDENT_EDITED_AFTER_TURN_IN']);
  const timestamps = history.map(entry => entry && entry.stateHistory)
    .filter(state => state && submittedStates.has(String(state.state || '')) && state.stateTimestamp)
    .map(state => String(state.stateTimestamp))
    .sort();
  return timestamps.length ? timestamps[timestamps.length - 1] : '';
}

function listClassroomApiExperimentCourses_() {
  const courses = [];
  let pageToken = '';
  do {
    const request = {
      studentId: 'me',
      courseStates: ['ACTIVE'],
      pageSize: 100
    };
    if (pageToken) request.pageToken = pageToken;
    const response = Classroom.Courses.list(request) || {};
    (response.courses || []).forEach(course => courses.push(course));
    pageToken = String(response.nextPageToken || '');
  } while (pageToken);
  return courses;
}

function listClassroomApiExperimentCoursework_(courseId) {
  const coursework = [];
  let pageToken = '';
  do {
    const request = {
      courseWorkStates: ['PUBLISHED'],
      pageSize: 100
    };
    if (pageToken) request.pageToken = pageToken;
    const response = Classroom.Courses.CourseWork.list(courseId, request) || {};
    (response.courseWork || []).forEach(item => coursework.push(item));
    pageToken = String(response.nextPageToken || '');
  } while (pageToken);
  return coursework;
}

function formatClassroomApiDateForExperiment_(value) {
  if (!value || !value.year || !value.month || !value.day) return '';
  return `${String(value.year).padStart(4, '0')}/${String(value.month).padStart(2, '0')}/${String(value.day).padStart(2, '0')}`;
}

/**
 * Classroom's dueDate and dueTime are UTC values. Convert a timed deadline
 * to Japan local time before showing or saving it. Date-only API deadlines
 * remain on their supplied calendar date and use TaskHub's 23:59 default.
 */
function getClassroomApiLocalDuePartsForExperiment_(item) {
  const dueDate = item && item.dueDate;
  const dateText = formatClassroomApiDateForExperiment_(dueDate);
  if (!dateText) return {dueDate: '', dueTime: '', dueTimeSource: ''};

  const year = Number(dueDate.year);
  const month = Number(dueDate.month);
  const day = Number(dueDate.day);
  if (!isValidClassroomApiDatePartsForExperiment_(year, month, day)) {
    return {dueDate: '', dueTime: '', dueTimeSource: 'API期限日が不正'};
  }

  const dueTime = item && item.dueTime;
  if (!dueTime) {
    return {dueDate: dateText, dueTime: '23:59', dueTimeSource: 'APIに時刻なしのため23:59'};
  }

  const hour = dueTime.hours === undefined ? 0 : Number(dueTime.hours);
  const minute = dueTime.minutes === undefined ? 0 : Number(dueTime.minutes);
  const second = dueTime.seconds === undefined ? 0 : Number(dueTime.seconds);
  const nanos = dueTime.nanos === undefined ? 0 : Number(dueTime.nanos);
  const validComponents = Number.isInteger(hour) && hour >= 0 && hour <= 24 &&
    Number.isInteger(minute) && minute >= 0 && minute <= 59 &&
    Number.isInteger(second) && second >= 0 && second <= 60 &&
    Number.isInteger(nanos) && nanos >= 0 && nanos <= 999999999;
  const valid24Hour = hour !== 24 || (minute === 0 && second === 0 && nanos === 0);
  if (!validComponents || !valid24Hour) {
    return {dueDate: '', dueTime: '', dueTimeSource: 'API期限時刻が不正'};
  }

  const utcDate = new Date(0);
  utcDate.setUTCFullYear(year, month - 1, day);
  utcDate.setUTCHours(hour, minute, second, Math.floor(nanos / 1000000));
  // TaskHub is Japan-only and its timezone is Asia/Tokyo (UTC+09:00).
  const localDate = new Date(utcDate.getTime() + 9 * 60 * 60 * 1000);
  let localYear = localDate.getUTCFullYear();
  let localMonth = localDate.getUTCMonth() + 1;
  let localDay = localDate.getUTCDate();
  let localHour = localDate.getUTCHours();
  let localMinute = localDate.getUTCMinutes();

  // Preserve TaskHub's established rule for a local midnight deadline.
  if (localHour === 0 && localMinute === 0 && localDate.getUTCSeconds() === 0 && localDate.getUTCMilliseconds() === 0) {
    const priorDate = new Date(0);
    priorDate.setUTCFullYear(localYear, localMonth - 1, localDay - 1);
    localYear = priorDate.getUTCFullYear();
    localMonth = priorDate.getUTCMonth() + 1;
    localDay = priorDate.getUTCDate();
    localHour = 23;
    localMinute = 59;
  }

  return {
    dueDate: `${String(localYear).padStart(4, '0')}/${String(localMonth).padStart(2, '0')}/${String(localDay).padStart(2, '0')}`,
    dueTime: `${String(localHour).padStart(2, '0')}:${String(localMinute).padStart(2, '0')}`,
    dueTimeSource: 'Classroom API（UTCから日本時間に変換）'
  };
}

function selectClassroomApiExperimentCurrentStudentSubmission_(submissions, currentStudentId) {
  if (!Array.isArray(submissions) || submissions.length === 0) return null;
  const identified = submissions.filter(submission => String(submission && submission.userId || '').trim());
  if (identified.length) {
    const matches = identified.filter(submission => String(submission.userId || '').trim() === String(currentStudentId || '').trim());
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error('現在の利用者に対する提出状況が複数返されました。');
    throw new Error('提出状況の利用者IDが現在のClassroom利用者と一致しません。');
  }
  // Backward-compatible for an API response already constrained to `me` that
  // omits userId. Never guess which row belongs to the current user.
  if (submissions.length === 1) return submissions[0];
  throw new Error('提出状況の利用者を特定できません。');
}

function isValidClassroomApiDatePartsForExperiment_(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
      year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatClassroomApiTimeForExperiment_(value) {
  if (!value || value.hours === undefined || value.minutes === undefined) return '';
  return `${String(value.hours).padStart(2, '0')}:${String(value.minutes).padStart(2, '0')}`;
}

function getClassroomApiExperimentErrorMessage_(error) {
  return String(error && error.message ? error.message : error || '不明なエラー');
}

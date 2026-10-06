function getNotificationsForWeb() {
  return getNotificationsForWebLocked_();
}

function getNotificationsForWebLocked_() {
  const startedAt = Date.now();
  const testMode = isTestCaseModeEnabled_();
  const deadlineReferenceNow = testMode ? getTestCaseReferenceNow_() : new Date(Date.now());
  const testSpreadsheet = testMode ? openTestCaseSpreadsheet_() : null;
  const testDateContext = testMode ? getTestCaseDateContext_(testSpreadsheet, deadlineReferenceNow) : null;
  const testStates = testMode ? getTestNotificationStateMap_() : null;
  const readContext = createNotificationReadContext_(testSpreadsheet, testMode);
  const contextReadyAt = Date.now();
  const activeItems = getActiveNotificationItemsForWeb_(testSpreadsheet, testStates, testDateContext, readContext);
  const activeReadyAt = Date.now();
  const supplementItems = getInCampusSupplementItemsForWeb_(testSpreadsheet, testStates, testDateContext, readContext);
  const supplementReadyAt = Date.now();
  const data = mergeNotificationAndInCampusExtractedItemsForWeb_(
    activeItems,
    supplementItems,
    'assignment',
    testMode
  );

  const result = data
    .filter(item => !isNotYetPublishedClassroomApiNotificationForWeb_(item, deadlineReferenceNow))
    .filter(item => !isExpiredNotificationForWeb_(item, deadlineReferenceNow))
    .filter(item => !isStaleUnknownDueNotificationForWeb_(item, deadlineReferenceNow))
    .sort((a, b) => (b.displayReceivedAtTime || b.receivedAtTime) - (a.displayReceivedAtTime || a.receivedAtTime));
  Logger.log('TASKHUB_NOTIFICATION_READ_TIMING ' + JSON.stringify({
    mode: testMode ? 'test' : 'personal',
    contextMs: contextReadyAt - startedAt,
    activePipelineMs: activeReadyAt - contextReadyAt,
    supplementPipelineMs: supplementReadyAt - activeReadyAt,
    mergeFilterSortMs: Date.now() - supplementReadyAt,
    totalMs: Date.now() - startedAt,
    sheetReadMs: readContext.sheetReadMs,
    sheetRowCounts: readContext.sheetRowCounts,
    itemCounts: {active: activeItems.length, supplement: supplementItems.length, returned: result.length},
    inCampusSnapshotReused: !testMode && Array.isArray(readContext.sourceRowsBySource.inCampus)
  }));
  return result;
}

function getActiveNotificationItemsForWeb_(testSpreadsheet, testStates, testDateContext, readContext) {
  return getActiveNotificationItemsForWebLocked_(testSpreadsheet, testStates, testDateContext, readContext);
}

function getActiveNotificationItemsForWebLocked_(testSpreadsheet, testStates, testDateContext, readContext) {
  const testMode = Boolean(testSpreadsheet || testStates) || isTestCaseModeEnabled_();
  const context = readContext || createNotificationReadContext_(testSpreadsheet, testMode);
  let rows = getNotificationRowsFromSheets_(context.sheetsBySource, testMode, testDateContext, context);
  applyTestNotificationStatesToRows_(rows, testStates);

  rows = rows.filter(row => isTaskRelatedRow_(row));
  rows = rows.filter(row => String(row[12] || '') !== '完了');

  const data = rows.map(row => rowToNotificationItem_(row));

  return data;
}

function getNotificationRowsFromSheets_(sheetsBySource, testMode, testDateContext, readContext, options = {}) {
  const rows = [];
  const useTestMode = typeof testMode === 'boolean' ? testMode : isTestCaseModeEnabled_();
  const dateContext = useTestMode
    ? (testDateContext || getTestCaseDateContext_(null, getTestCaseReferenceNow_()))
    : null;

  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    const sheet = sheetsBySource && sheetsBySource[storageConfig.source];

    if (!sheet || sheet.getLastRow() < 2) {
      return;
    }

    const readStartedAt = Date.now();
    let sourceRows = sheet.getDataRange().getValues().slice(1);
    if (readContext) {
      readContext.sheetReadMs[storageConfig.source] = (readContext.sheetReadMs[storageConfig.source] || 0) + Date.now() - readStartedAt;
      readContext.sheetRowCounts[storageConfig.source] = sourceRows.length;
      readContext.sourceRowsBySource[storageConfig.source] = sourceRows;
    }
    if (!useTestMode && storageConfig.source === 'inCampus') {
      sourceRows = sourceRows.filter(row =>
        String(row[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] || '') === INCAMPUS_GMAIL_RECORD_TYPE ||
        (String(row[2] || '') === 'inCampus' && String(row[1] || '') && !row[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN])
      );
    }
    const rowsForRead = useTestMode
      ? sourceRows.map(row => mapTestCaseNotificationRowForRead_(row, dateContext))
      : sourceRows;
    const retainedRows = normalizeNotificationRowsForStorage_(rowsForRead, storageConfig);
    retainedRows.forEach(row => rows.push(...expandInCampusNotificationRow_(row)));
  });

  // Classroom API tasks live in the structured 授業 / Classroom課題 / 提出状況
  // tabs. Convert them to the existing display model without writing a second copy.
  if (!useTestMode && options.includeClassroomApi !== false) {
    rows.push(...getClassroomApiNotificationRowsForWeb_(readContext && readContext.spreadsheet, readContext));
  }

  return options.mergeClassroomApiAssignments === false
    ? rows
    : mergeClassroomGmailAssignmentsWithApiRowsForWeb_(rows);
}

/**
 * Gmail assignment emails arrive before the hourly API snapshot. Keep their
 * raw rows in 補足通知, show unmatched emails immediately, and collapse an
 * unambiguous match into the API-owned task after Classroom sync completes.
 */
function mergeClassroomGmailAssignmentsWithApiRowsForWeb_(rows) {
  const apiRows = rows.filter(row => isClassroomApiManagedRow_(row));
  if (!apiRows.length) return rows;

  const apiByUrl = new Map();
  const apiByCourseTitle = new Map();
  const addIndex = (map, key, row) => {
    if (!key) return;
    const matches = map.get(key) || [];
    matches.push(row);
    map.set(key, matches);
  };
  const courseTitleKey = row => [
    normalizeClassroomCourseNameForMatch_(row[3]),
    normalizeInCampusMatchText_(row[4])
  ].join('\u001f');

  apiRows.forEach(row => {
    const url = normalizeClassroomUrlForMatch_(extractClassroomUrl_('Google Classroom', row[11]));
    if (url) addIndex(apiByUrl, url, row);
    addIndex(apiByCourseTitle, courseTitleKey(row), row);
  });

  const matchedEmailsByApiId = new Map();
  const consumedEmailIds = new Set();
  rows.forEach(row => {
    if (String(row[2] || '') !== 'Google Classroom' ||
        isClassroomApiManagedRow_(row) ||
        getClassroomNotificationType_(row[11]) !== 'newAssignment') return;

    const emailId = String(row[1] || '');
    const emailUrl = normalizeClassroomUrlForMatch_(extractClassroomUrl_('Google Classroom', row[11]));
    let matches = emailUrl ? (apiByUrl.get(emailUrl) || []) : [];

    // A title/course fallback is safe only when one side lacks a URL and the
    // normalized course-title pair identifies exactly one API task.
    if (!matches.length && !emailUrl) {
      matches = apiByCourseTitle.get(courseTitleKey(row)) || [];
    }
    if (emailUrl && !matches.length) {
      const sameTitle = apiByCourseTitle.get(courseTitleKey(row)) || [];
      if (sameTitle.length === 1) {
        const apiUrl = normalizeClassroomUrlForMatch_(extractClassroomUrl_('Google Classroom', sameTitle[0][11]));
        if (!apiUrl) matches = sameTitle;
      }
    }
    if (matches.length !== 1) return;

    const apiRow = matches[0];
    const relatedEmails = matchedEmailsByApiId.get(String(apiRow[1])) || [];
    relatedEmails.push(row);
    matchedEmailsByApiId.set(String(apiRow[1]), relatedEmails);
    consumedEmailIds.add(emailId);
  });

  const mergedApiRows = new Map();
  apiRows.forEach(apiRow => {
    const emails = matchedEmailsByApiId.get(String(apiRow[1] || '')) || [];
    if (!emails.length) return;
    emails.sort((a, b) => getTimeForSort_(b[9]) - getTimeForSort_(a[9]));
    const latest = emails[0];
    const merged = apiRow.slice();
    // API fields (task identity, due date, description and status) stay intact.
    // Gmail-only delivery details are carried in in-memory columns for the UI.
    if (!String(merged[3] || '').trim()) merged[3] = latest[3];
    if (!String(merged[4] || '').trim() || String(merged[4]).includes('課題名なし')) merged[4] = latest[4];
    merged[7] = latest[7] || merged[7];
    merged[8] = latest[8] || merged[8];
    merged[10] = latest[10] || '';
    const apiUrl = extractClassroomUrl_('Google Classroom', merged[11]);
    const gmailUrl = extractClassroomUrl_('Google Classroom', latest[11]);
    if (!apiUrl && gmailUrl) merged[11] = [merged[11], gmailUrl].filter(Boolean).join('\n\n');
    const apiDescription = String(merged[11] || '')
      .replace(/https?:\/\/[^\s<>]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!apiDescription && latest[11]) {
      merged[11] = [merged[11], '【APIに本文がないためGmailから補足】', latest[11]].filter(Boolean).join('\n\n');
    }
    merged[17] = latest[1] || '';
    merged[18] = latest[10] || '';
    merged[19] = latest[11] || '';
    merged[20] = emails.map(row => String(row[1] || '')).filter(Boolean);
    merged[21] = latest[9] || '';
    mergedApiRows.set(String(apiRow[1]), merged);
  });

  return rows
    .filter(row => !consumedEmailIds.has(String(row[1] || '')))
    .map(row => isClassroomApiManagedRow_(row) ? (mergedApiRows.get(String(row[1])) || row) : row);
}

function getTestNotificationStateMap_() {
  if (!isTestCaseModeEnabled_()) return {};
  const prefix = TEST_NOTIFICATION_STATE_PROPERTY_PREFIX;
  const properties = PropertiesService.getUserProperties().getProperties();
  const states = {};
  Object.keys(properties).forEach(key => {
    if (!key.startsWith(prefix)) return;
    try {
      const state = JSON.parse(properties[key]);
      if (state && (state.status === '完了' || state.status === '未確認')) {
        states[key.slice(prefix.length)] = state;
      }
    } catch (_) {
      // Ignore malformed per-user test state and keep the spreadsheet value.
    }
  });
  return states;
}

function getTestNotificationState_(messageId, testStates) {
  if (!isTestCaseModeEnabled_()) return null;
  if (testStates) return testStates[String(messageId || '')] || null;
  const raw = PropertiesService.getUserProperties().getProperty(TEST_NOTIFICATION_STATE_PROPERTY_PREFIX + String(messageId || ''));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    return state && (state.status === '完了' || state.status === '未確認') ? state : null;
  } catch (_) {
    return null;
  }
}

function saveTestNotificationState_(messageId, status) {
  const id = String(messageId || '');
  if (!id || id.length > 450 || (status !== '完了' && status !== '未確認')) return false;
  const state = {status, completedAt: status === '完了' ? new Date().toISOString() : ''};
  PropertiesService.getUserProperties().setProperty(TEST_NOTIFICATION_STATE_PROPERTY_PREFIX + id, JSON.stringify(state));
  return true;
}

function clearTestNotificationStates_() {
  const props = PropertiesService.getUserProperties();
  Object.keys(props.getProperties()).forEach(key => {
    if (key.indexOf(TEST_NOTIFICATION_STATE_PROPERTY_PREFIX) === 0 || key.indexOf('universityNotice:test:') === 0) {
      props.deleteProperty(key);
    }
  });
}

function applyTestNotificationStatesToRows_(rows, testStates) {
  if (testStates !== undefined ? !testStates : !isTestCaseModeEnabled_()) return rows;
  const states = testStates || getTestNotificationStateMap_();
  rows.forEach(row => {
    const state = states[String(row[1] || '')] || null;
    if (!state) return;
    row[12] = state.status;
    row[13] = state.completedAt || '';
  });
  return rows;
}

function applyTestNotificationStateToItem_(item, testStates) {
  const state = testStates !== undefined
    ? (testStates && testStates[String(item && item.messageId || '')] || null)
    : getTestNotificationState_(item && item.messageId);
  if (!state) return item;
  item.status = state.status;
  item.completedAt = state.completedAt || '';
  item.completedAtTime = getTimeForSort_(state.completedAt);
  return item;
}


function getTimeForSort_(value) {
  if (value instanceof Date) {
    return value.getTime();
  }

  const date = new Date(value);
  const time = date.getTime();

  if (Number.isNaN(time)) {
    return 0;
  }

  return time;
}

function buildDeadlineDateTimeForWeb_(dateKey, dueTime) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!isValidDateParts_(year, month, day)) {
    return null;
  }

  let hour = 23;
  let minute = 59;

  if (dueTime) {
    const parts = String(dueTime).split(':');

    if (parts.length === 2) {
      const parsedHour = Number(parts[0]);
      const parsedMinute = Number(parts[1]);

      if (
        Number.isInteger(parsedHour) &&
        Number.isInteger(parsedMinute) &&
        parsedHour >= 0 &&
        parsedHour <= 23 &&
        parsedMinute >= 0 &&
        parsedMinute <= 59
      ) {
        hour = parsedHour;
        minute = parsedMinute;
      }
    }
  }

  // Deadline inputs have minute precision; treat the full minute as valid.
  return new Date(year, month - 1, day, hour, minute, 59, 999);
}

function isExpiredNotificationForWeb_(item, referenceNow) {
  if (item.dueType !== 'detected') {
    return false;
  }

  if (!item.dueDateKey) {
    return false;
  }

  const deadline = buildDeadlineDateTimeForWeb_(item.dueDateKey, item.dueTime);

  if (!deadline) {
    return false;
  }

  const now = referenceNow instanceof Date
    ? referenceNow
    : isTestCaseModeEnabled_() ? getTestCaseReferenceNow_() : new Date(Date.now());
  return deadline.getTime() < now.getTime();
}

function isStaleUnknownDueNotificationForWeb_(item, referenceNow) {
  const isApiCoursework = String(item && item.messageId || '').startsWith('classroom-api:');
  if (isApiCoursework) {
    if (item.dueType === 'detected') return false;
  } else if (item.dueType !== 'unknown') {
    return false;
  }

  const receivedAtTime = Number(item && item.receivedAtTime);
  if (!Number.isFinite(receivedAtTime) || receivedAtTime <= 0) return false;

  const retentionMs = (isApiCoursework ? 21 : 7) * 24 * 60 * 60 * 1000;
  const now = referenceNow instanceof Date ? referenceNow.getTime() : Date.now();
  return now > receivedAtTime + retentionMs;
}

function isClassroomUrlOrWrappedUrlLine_(line) {
  const text = String(line || '').trim();

  if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('<http')) {
    return true;
  }

  if (text.includes('accounts.google.com')) {
    return true;
  }

  if (text.includes('classroom.google.com')) {
    return true;
  }

  if (text.includes('continue=')) {
    return true;
  }

  if (text.includes('Email=')) {
    return true;
  }

  if (text.includes('email%3D')) {
    return true;
  }

  if (text.includes('senshu-u.jp')) {
    return true;
  }

  return false;
}

function getClassroomMeaningfulLines_(body) {
  return getCleanLines_(body)
    .filter(line => {
      const text = String(line || '').trim();

      if (text === '') {
        return false;
      }

      if (text === '通知設定') {
        return false;
      }

      if (text === '詳細を表示') {
        return false;
      }

      if (text === '課題を表示') {
        return false;
      }

      if (text === '成績を表示') {
        return false;
      }

      if (text === '返信') {
        return false;
      }

      if (isClassroomUrlOrWrappedUrlLine_(text)) {
        return false;
      }

      if (text.includes('Google LLC')) {
        return false;
      }

      if (text.includes('このメールは、Google Classroom')) {
        return false;
      }

      if (text.includes('配信停止')) {
        return false;
      }

      if (text.includes('設定の変更')) {
        return false;
      }

      if (text.startsWith('投稿日:')) {
        return false;
      }

      return true;
    });
}

function isClassroomNotificationMarker_(line) {
  const text = String(line || '').trim();

  return text.includes('新しい課題') ||
    text.includes('新しい資料') ||
    text.includes('新しいお知らせ') ||
    text.includes('限定公開のコメント') ||
    text.includes('返却済み') ||
    text.includes('返却された課題');
}

function getClassroomNotificationMarkerIndex_(lines) {
  return lines.findIndex(line => isClassroomNotificationMarker_(line));
}

function getClassroomNotificationType_(body) {
  const lines = getClassroomMeaningfulLines_(body);
  const markerIndex = getClassroomNotificationMarkerIndex_(lines);

  const headText = markerIndex >= 0
    ? lines.slice(Math.max(0, markerIndex - 1), markerIndex + 2).join('\n')
    : lines.slice(0, 7).join('\n');

  if (headText.includes('新しい資料')) {
    return 'newMaterial';
  }

  if (headText.includes('限定公開のコメント')) {
    return 'privateComment';
  }

  if (
    headText.includes('返却済み') ||
    headText.includes('返却された課題')
  ) {
    return 'returned';
  }

  if (headText.includes('新しい課題')) {
    return 'newAssignment';
  }

  if (headText.includes('新しいお知らせ')) {
    return 'newAnnouncement';
  }

  return 'other';
}

function isTaskRelatedRow_(row) {
  const source = String(row[2] || '');
  const dueStatus = String(row[6] || '');
  const status = String(row[12] || '');
  const subject = String(row[7] || '');
  const body = String(row[11] || '');

  if (isClassroomApiManagedRow_(row)) {
    return true;
  }

  if (isClassroomExtensionSyncRow_(row)) {
    return false;
  }

  if (
    dueStatus === '提出記録' ||
    status === '完了記録'
  ) {
    return false;
  }

  if (source !== 'Google Classroom' && source !== 'inCampus') {
    return false;
  }

  if (source === 'Google Classroom') {
    const notificationType = getClassroomNotificationType_(body);

    return notificationType === 'newAssignment';
  }

  return getInCampusMailKind_(body) === 'assignment';
}

function isClassroomExtensionSyncRow_(row) {
  const source = String(row[2] || '');

  if (source !== 'Google Classroom') {
    return false;
  }

  const messageId = String(row[1] || '');
  const dueStatus = String(row[6] || '');
  const subject = String(row[7] || '');
  const from = String(row[8] || '');

  return from === 'Google Classroom同期' ||
    subject.startsWith('Classroom完了同期:') ||
    subject.startsWith('Classroom期限同期:') ||
    (messageId.startsWith('classroom:') && dueStatus.startsWith('Classroomで'));
}

function isNonActionableNotification_(text) {
  const normalizedText = String(text || '').replace(/\s+/g, '');
  const gradeKeywords = [
    '採点済み',
    '採点しました',
    '課題を採点',
    '成績:',
    '成績：',
    '成績を表示',
    '採点結果',
    '返却されました',
    '評価を返却'
  ];

  return gradeKeywords.some(keyword => normalizedText.includes(keyword));
}

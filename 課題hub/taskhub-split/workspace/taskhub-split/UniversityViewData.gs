function getActiveInCampusExtractedItemsForWeb_() {
  return getInCampusExtractedItemsForWeb_('active');
}

function getCompletedInCampusExtractedItemsForWeb_() {
  return getInCampusExtractedItemsForWeb_('completed');
}

function getInCampusExtractedItemsForWeb_(viewMode) {
  return runWithUserLock_('保存データ処理', () => getInCampusExtractedItemsForWebLocked_(viewMode));
}

function getInCampusExtractedItemsForWebLocked_(viewMode) {
  const testMode = isTestCaseModeEnabled_();
  const testSpreadsheet = testMode ? openTestCaseSpreadsheet_() : null;
  const testStates = testMode ? getTestNotificationStateMap_() : null;
  const sheet = getInCampusReadSheet_(testSpreadsheet);

  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  const values = sheet.getDataRange().getValues();
  const headerMap = getInCampusHeaderMap_(sheet);
  const testReferenceDate = testMode ? getTestCaseReferenceNow_() : null;
  const rows = values.slice(1).map(row => testMode
    ? mapTestCaseExtractRowForRead_(row, testReferenceDate)
    : row);
  const items = rows
    .map(row => rowToInCampusExtractedItem_(row, headerMap))
    .filter(item => item.messageId)
    .map(item => applyTestNotificationStateToItem_(item, testStates));
  const submissionItems = items.filter(item => isInCampusSubmissionItemForWeb_(item));
  const assignmentItems = items.filter(item => !isInCampusSubmissionItemForWeb_(item));

  // Submission events are persisted once during ingestion; reads must respect manual undo.
  applyNotificationCompletionToInCampusExtractedItemsForWeb_(assignmentItems);

  return assignmentItems
    .filter(item => {
      if (viewMode === 'completed') {
        return item.status === '完了';
      }

      return item.status !== '完了';
    });
}

function getInCampusHeaderMap_(sheet) {
  const headerValues = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0];
  const headerMap = {};

  headerValues.forEach((header, index) => {
    const name = String(header || '').trim();

    if (name) {
      headerMap[name] = index + 1;
    }
  });

  return headerMap;
}

function getInCampusCell_(row, headerMap, headerName, fallbackIndex) {
  const column = headerMap[headerName] || 0;

  if (column > 0) {
    return row[column - 1];
  }

  if (fallbackIndex >= 0) {
    return row[fallbackIndex];
  }

  return '';
}

function hasInCampusHeader_(headerMap, headerName) {
  return Boolean(headerMap && headerMap[headerName]);
}

function rowToInCampusExtractedItem_(row, headerMap) {
  const source = String(getInCampusCell_(row, headerMap, 'source', 0) || 'inCampus');
  const rawType = String(getInCampusCell_(row, headerMap, 'type', 1) || '');
  const title = String(getInCampusCell_(row, headerMap, 'title', 2) || '');
  const body = String(getInCampusCell_(row, headerMap, 'body', 3) || '');
  const periodText = getInCampusCell_(row, headerMap, 'periodText', 6);
  const dueAtValue = getInCampusCell_(row, headerMap, 'dueAt', 5) || extractDueAtFromPeriodText_(periodText) || '';
  const hasDueAt = isPresentValue_(dueAtValue);
  const pageUrl = String(getInCampusCell_(row, headerMap, 'pageUrl', 10) || '');
  const extractedAt = getInCampusCell_(row, headerMap, 'extractedAt', 11) || getInCampusCell_(row, headerMap, 'receivedAt', 12) || '';
  const receivedAt = getInCampusCell_(row, headerMap, 'receivedAt', 12) || getInCampusCell_(row, headerMap, 'extractedAt', 11) || '';
  const raw = parseInCampusRawJson_(getInCampusCell_(row, headerMap, 'rawJson', 13));
  const status = hasInCampusHeader_(headerMap, 'status')
    ? String(getInCampusCell_(row, headerMap, 'status', -1) || '未確認')
    : String(raw.status || '未確認');
  const completedAt = hasInCampusHeader_(headerMap, 'completedAt')
    ? getInCampusCell_(row, headerMap, 'completedAt', -1)
    : raw.completedAt || '';
  const courseNameFromColumn = hasInCampusHeader_(headerMap, 'courseName')
    ? String(getInCampusCell_(row, headerMap, 'courseName', -1) || '')
    : '';
  const updateText = String(getInCampusCell_(row, headerMap, 'updateText', -1) || raw.updateText || '');
  const updateAction = String(getInCampusCell_(row, headerMap, 'updateAction', -1) || raw.updateAction || raw.action || '');
  const updateAt = getInCampusCell_(row, headerMap, 'updateAt', -1) || raw.updateAt || '';
  const dueInfo = normalizeDueInfoForWeb_(dueAtValue, hasDueAt ? '拡張機能で抽出' : '期限未検出・要確認');
  const receivedAtTime = getTimeForSort_(receivedAt || extractedAt);
  const completedAtTime = getTimeForSort_(completedAt);
  const messageId = pageUrl ? `incampus:${pageUrl}` : '';
  const detailLines = [
    body,
    periodText ? `提出期間: ${periodText}` : '',
    getInCampusCell_(row, headerMap, 'lateSubmission', 7) ? `期間外提出: ${getInCampusCell_(row, headerMap, 'lateSubmission', 7)}` : '',
    getInCampusCell_(row, headerMap, 'assignmentType', 8) ? `課題種別: ${getInCampusCell_(row, headerMap, 'assignmentType', 8)}` : '',
    getInCampusCell_(row, headerMap, 'attachment', 9) ? `添付ファイル: ${getInCampusCell_(row, headerMap, 'attachment', 9)}` : ''
  ].filter(Boolean);

  return {
    savedAt: formatDateForWeb_(extractedAt),
    messageId,
    source,
    rawType,
    assignmentKey: String(getInCampusCell_(row, headerMap, 'assignmentKey', -1) || raw.assignmentKey || ''),
    extractedAt: formatDateForWeb_(extractedAt),
    rawUpdateText: updateText,
    rawUpdateAction: updateAction,
    rawUpdateAt: updateAt,
    courseName: courseNameFromColumn || raw.courseName || 'inCampus',
    title: title || raw.title || 'タイトル未抽出',

    dueDate: dueInfo.dueDate,
    dueDateKey: dueInfo.dueDateKey,
    dueTime: dueInfo.dueTime,
    dueType: dueInfo.dueType,

    dueStatus: hasDueAt ? '拡張機能で抽出' : '期限未検出・要確認',
    subject: title || raw.title || '',
    from: 'inCampus',
    receivedAt: formatDateForWeb_(receivedAt || extractedAt),
    receivedAtTime: receivedAtTime,
    gmailLink: '',
    classroomUrl: pageUrl,
    body: detailLines.join('\n\n'),
    status,
    completedAt: formatDateForWeb_(completedAt),
    completedAtTime: completedAtTime
  };
}

function isInCampusSubmissionItemForWeb_(item) {
  if (!item) {
    return false;
  }

  if (
    item.rawType === INCAMPUS_SUBMISSION_RECORD_TYPE ||
    item.status === INCAMPUS_SUBMISSION_RECORD_STATUS
  ) {
    return true;
  }

  const updateText = String(item.rawUpdateText || '');
  const updateAction = String(item.rawUpdateAction || '').toLowerCase();

  return /提出しました|提出されました|提出済/.test(updateText) ||
    /submit|submitted|submission/.test(updateAction);
}

function applyInCampusSubmissionItemsForWeb_(assignmentItems, submissionItems) {
  submissionItems.forEach(submissionItem => {
    const record = getInCampusSubmissionRecordFromItemForWeb_(submissionItem);

    if (!record.title) {
      return;
    }

    const target = findMatchingInCampusAssignmentItem_(assignmentItems, record);

    if (!target) {
      return;
    }

    target.status = '完了';
    target.completedAt = formatDateForWeb_(record.submittedAt || submissionItem.receivedAt || new Date());
    target.completedAtTime = getTimeForSort_(record.submittedAt || submissionItem.receivedAtTime || new Date());
  });
}

function getInCampusSubmissionRecordFromItemForWeb_(item) {
  return {
    courseName: item.courseName || '',
    title: extractInCampusSubmittedItemTitle_(item.rawUpdateText) || item.title || '',
    submittedAt: item.rawUpdateAt || item.receivedAt || item.completedAt || ''
  };
}

function findMatchingInCampusAssignmentItem_(assignmentItems, record) {
  const matches = assignmentItems.filter(item => isSameInCampusAssignmentForWeb_(item, record));
  return matches.length === 1 ? matches[0] : null;
}

function isPresentValue_(value) {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }

  return String(value || '').trim() !== '';
}

function parseInCampusRawJson_(value) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function extractDueAtFromPeriodText_(periodText) {
  const parts = String(periodText || '')
    .split(/[～〜~]/)
    .map(part => String(part || '').trim())
    .filter(Boolean);

  return parts.length >= 2 ? parts[1] : '';
}

function updateInCampusExtractedStatus_(messageId, status) {
  return runWithUserLock_('保存データ処理', () => updateInCampusExtractedStatusLocked_(messageId, status));
}

function updateInCampusExtractedStatusLocked_(messageId, status) {
  const pageUrl = String(messageId || '').replace(/^incampus:/, '');

  if (!pageUrl) {
    return;
  }

  const sheet = getOrCreateInCampusSheet_();

  if (!sheet || sheet.getLastRow() < 2) {
    return;
  }

  setupInCampusHeader_(sheet);

  const headerMap = getInCampusHeaderMap_(sheet);
  const pageUrlColumn = headerMap.pageUrl || INCAMPUS_HEADERS.indexOf('pageUrl') + 1;
  const statusColumn = headerMap.status || 0;
  const completedAtColumn = headerMap.completedAt || 0;

  if (!pageUrlColumn || !statusColumn || !completedAtColumn) {
    return;
  }

  const urls = sheet.getRange(2, pageUrlColumn, sheet.getLastRow() - 1, 1).getValues();
  const existingIndex = urls.findIndex(row => String(row[0] || '') === pageUrl);

  if (existingIndex === -1) {
    return;
  }

  const rowNumber = existingIndex + 2;
  sheet.getRange(rowNumber, statusColumn).setValue(status);

  if (status === '完了') {
    sheet.getRange(rowNumber, completedAtColumn).setValue(new Date());
  } else {
    sheet.getRange(rowNumber, completedAtColumn).clearContent();
  }

  SpreadsheetApp.flush();
}

function getCompletedNotificationsForWeb() {
  return runWithUserLock_('保存データ処理', () => getCompletedNotificationsForWebLocked_());
}

function getCompletedNotificationsForWebLocked_() {
  const testMode = isTestCaseModeEnabled_();
  const deadlineReferenceNow = testMode ? getTestCaseReferenceNow_() : new Date(Date.now());
  const testSpreadsheet = testMode ? openTestCaseSpreadsheet_() : null;
  const testStates = testMode ? getTestNotificationStateMap_() : null;
  const data = mergeNotificationAndInCampusExtractedItemsForWeb_(
    getCompletedNotificationItemsForWeb_(testSpreadsheet, testStates),
    getInCampusSupplementItemsForWeb_(testSpreadsheet, testStates),
    'assignment',
    testMode
  );

  return data
    .filter(item => !isExpiredNotificationForWeb_(item, deadlineReferenceNow))
    .filter(item => !isStaleUnknownDueNotificationForWeb_(item))
    .sort((a, b) => {
      if (a.completedAtTime !== b.completedAtTime) {
        return b.completedAtTime - a.completedAtTime;
      }

      return b.receivedAtTime - a.receivedAtTime;
    });
}

function getInCampusSupplementItemsForWeb_(testSpreadsheet, testStates) {
  return runWithUserLock_('保存データ処理', () => getInCampusSupplementItemsForWebLocked_(testSpreadsheet, testStates));
}

function getInCampusSupplementItemsForWebLocked_(testSpreadsheet, testStates) {
  const testMode = Boolean(testSpreadsheet || testStates) || isTestCaseModeEnabled_();
  const states = testMode ? (testStates || getTestNotificationStateMap_()) : null;
  const sheet = getInCampusReadSheet_(testSpreadsheet);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const headerMap = getInCampusHeaderMap_(sheet);
  const testReferenceDate = testMode ? getTestCaseReferenceNow_() : null;
  return sheet.getDataRange().getValues().slice(1)
    .map(row => testMode ? mapTestCaseExtractRowForRead_(row, testReferenceDate) : row)
    .map(row => rowToInCampusExtractedItem_(row, headerMap))
    .map(item => applyTestNotificationStateToItem_(item, states));
}

function normalizeInCampusExactText_(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function getInCampusCourseIdentity_(item) {
  let name = normalizeInCampusExactText_(item && item.courseName).replace(/^[\[［](.*)[\]］]$/, '$1');
  const prefix = name.match(/^([月火水木金土日])\s*(\d+)\s+/);
  let schedule = prefix ? prefix[1] + prefix[2] : '';
  if (prefix) name = name.slice(prefix[0].length);
  const period = normalizeInCampusExactText_(item && item.weekdayPeriod);
  const day = period.match(/([月火水木金土日])曜/);
  const slot = period.match(/(\d+)限/);
  if (day && slot) schedule = day[1] + slot[1];
  return {name: name.trim(), schedule};
}

function isInCampusReportDetailUrl_(value, testMode) {
  const url = String(value || '');
  const useTestMode = typeof testMode === 'boolean' ? testMode : isTestCaseModeEnabled_();
  return /^https:\/\/ic\.ss\.senshu-u\.ac\.jp\/lms\/course\/report\//.test(url) ||
    (useTestMode && /^https:\/\/portal\.example\.invalid\/course\/report\/SIM-\d{4}$/.test(url));
}

function mergeNotificationAndInCampusExtractedItemsForWeb_(notificationItems, extractedItems, kind, testMode) {
  const expectedKind = kind || 'assignment';
  const useTestMode = typeof testMode === 'boolean' ? testMode : isTestCaseModeEnabled_();
  return notificationItems.map(notification => {
    if (notification.source !== 'inCampus') return notification;
    const candidates = extractedItems.filter(item => {
      const itemKind = item.rawUpdateText ? getInCampusUpdateKind_(item.rawUpdateText) : item.rawType;
      if (itemKind !== expectedKind || item.rawType === 'submissionRecord') return false;
      if (expectedKind === 'assignment' && !isInCampusReportDetailUrl_(item.classroomUrl, useTestMode)) return false;
      return isSameInCampusAssignmentForWeb_(notification, item);
    });
    // Updates of the same report are one candidate; different reports are ambiguous.
    const identities = new Set(candidates.map(item => expectedKind === 'assignment'
      ? item.classroomUrl : item.assignmentKey || item.classroomUrl));
    if (identities.size !== 1 || !candidates.length) return notification;
    const supplement = candidates.slice().sort((a,b) => b.receivedAtTime - a.receivedAtTime)[0];
    const result = Object.assign({}, notification, {
      supplementKey: supplement.assignmentKey || supplement.classroomUrl,
      supplementUpdatedAt: supplement.extractedAt || supplement.receivedAt
    });
    if (expectedKind === 'assignment') {
      if (supplement.dueType === 'detected') {
        ['dueDate','dueDateKey','dueTime','dueType','dueStatus'].forEach(key => result[key] = supplement[key]);
      }
      result.classroomUrl = supplement.classroomUrl;
      if (supplement.body) result.body = [notification.body, '【inCampusからの補足】', supplement.body].filter(Boolean).join('\n\n');
    }
    if (expectedKind === 'announcement' && supplement.rawUpdateText) {
      result.body = [notification.body, '【inCampusの更新通知】', supplement.rawUpdateText].filter(Boolean).join('\n\n');
    }
    // Mail message ID, received date, title, course, status and Gmail link remain authoritative.
    return result;
  });
}

function enrichInCampusExtractedItemsFromNotificationItemsForWeb_(notificationItems, extractedItems) {
  notificationItems
    .filter(item => String(item.source || '') === 'inCampus')
    .forEach(notificationItem => {
      const notificationCourseName = normalizeInCampusCourseNameForMatch_(notificationItem.courseName);

      if (isGenericInCampusCourseNameForMatch_(notificationCourseName)) {
        return;
      }

      const target = extractedItems.find(extractedItem => isSameInCampusAssignmentForWeb_(notificationItem, extractedItem));

      if (!target) {
        return;
      }

      const targetCourseName = normalizeInCampusCourseNameForMatch_(target.courseName);

      if (isGenericInCampusCourseNameForMatch_(targetCourseName)) {
        target.courseName = notificationItem.courseName;
      }
    });
}

function applyNotificationCompletionToInCampusExtractedItemsForWeb_(assignmentItems) {
  const completedNotificationItems = getCompletedNotificationItemsForWeb_()
    .filter(item => String(item.source || '') === 'inCampus');

  completedNotificationItems.forEach(completedItem => {
    const target = assignmentItems.find(item => isSameInCampusAssignmentForWeb_(completedItem, item));

    if (!target) {
      return;
    }

    target.status = '完了';
    target.completedAt = completedItem.completedAt || completedItem.receivedAt || '';
    target.completedAtTime = completedItem.completedAtTime || completedItem.receivedAtTime || 0;
  });
}

function isSameInCampusAssignmentForWeb_(a, b) {
  const titleA = normalizeInCampusExactText_(a && a.title);
  const titleB = normalizeInCampusExactText_(b && b.title);
  const courseA = getInCampusCourseIdentity_(a);
  const courseB = getInCampusCourseIdentity_(b);
  if (!titleA || !titleB || !courseA.name || !courseB.name) return false;
  if (isGenericInCampusCourseNameForMatch_(courseA.name.toLowerCase()) || isGenericInCampusCourseNameForMatch_(courseB.name.toLowerCase())) return false;
  if (courseA.schedule && courseB.schedule && courseA.schedule !== courseB.schedule) return false;
  return titleA === titleB && courseA.name === courseB.name;
}

function isGenericInCampusCourseNameForMatch_(courseName) {
  const text = String(courseName || '');

  return text === '' ||
    text === 'incampus' ||
    text === 'incampusお知らせ';
}

function getCompletedNotificationItemsForWeb_(testSpreadsheet, testStates) {
  return runWithUserLock_('保存データ処理', () => getCompletedNotificationItemsForWebLocked_(testSpreadsheet, testStates));
}

function getCompletedNotificationItemsForWebLocked_(testSpreadsheet, testStates) {
  const testMode = Boolean(testSpreadsheet || testStates) || isTestCaseModeEnabled_();
  const sheetsBySource = getNotificationReadSheets_(testSpreadsheet);
  let rows = getNotificationRowsFromSheets_(sheetsBySource, testMode);
  applyTestNotificationStatesToRows_(rows, testStates);

  rows = rows.filter(row => isTaskRelatedRow_(row));
  rows = rows.filter(row => String(row[12] || '') === '完了');

  const data = rows.map(row => rowToNotificationItem_(row));

  return data;
}

function debugNotificationSheet() {
  return runWithUserLock_('保存データ処理', () => debugNotificationSheetLocked_());
}

function debugNotificationSheetLocked_() {
  const ss = getOrCreateSpreadsheet_();
  const sheetsBySource = ensureNotificationStorage_(ss);

  Logger.log('スプレッドシートURL: ' + ss.getUrl());

  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    const sheet = sheetsBySource[storageConfig.source];
    const dataRowCount = Math.max(0, sheet.getLastRow() - 1);

    Logger.log('シート名: ' + sheet.getName());
    Logger.log('シートID: ' + sheet.getSheetId());
    Logger.log('データ行数: ' + dataRowCount);
  });
}

function debugWebData() {
  const data = getNotificationsForWeb();

  Logger.log('Web表示件数: ' + data.length);

  data.slice(0, 10).forEach((item, index) => {
    Logger.log(JSON.stringify({
      index: index + 1,
      source: item.source,
      courseName: item.courseName,
      title: item.title,
      dueDate: item.dueDate,
      dueDateKey: item.dueDateKey,
      dueTime: item.dueTime,
      dueType: item.dueType,
      dueStatus: item.dueStatus,
      receivedAt: item.receivedAt
    }, null, 2));
  });
}

function debugDueDateExtraction() {
  const samples = [
    '提出期限：2026/07/01 23:59',
    '期限 2026年6月26日',
    '期限 6月26日 23:59',
    '7/1 23:59',
    '成績: 100/100',
    '明日まで',
    '今週金曜まで',
    '期限なし'
  ];

  samples.forEach(sample => {
    Logger.log(JSON.stringify({
      input: sample,
      result: extractDueDate_(sample, new Date())
    }, null, 2));
  });
}

function rebuildNotificationsManually() {
  const data = rebuildAndGetNotificationsForWeb();

  Logger.log('増分同期が完了しました。表示対象件数: ' + data.length);
}

function getNotificationsForWeb() {
  return runWithUserLock_('保存データ処理', () => getNotificationsForWebLocked_());
}

function getNotificationsForWebLocked_() {
  const testMode = isTestCaseModeEnabled_();
  const deadlineReferenceNow = testMode ? getTestCaseReferenceNow_() : new Date(Date.now());
  const testSpreadsheet = testMode ? openTestCaseSpreadsheet_() : null;
  const testStates = testMode ? getTestNotificationStateMap_() : null;
  const data = mergeNotificationAndInCampusExtractedItemsForWeb_(
    getActiveNotificationItemsForWeb_(testSpreadsheet, testStates),
    getInCampusSupplementItemsForWeb_(testSpreadsheet, testStates),
    'assignment',
    testMode
  );

  return data
    .filter(item => !isExpiredNotificationForWeb_(item, deadlineReferenceNow))
    .filter(item => !isStaleUnknownDueNotificationForWeb_(item))
    .sort((a, b) => b.receivedAtTime - a.receivedAtTime);
}

function getActiveNotificationItemsForWeb_(testSpreadsheet, testStates) {
  return runWithUserLock_('保存データ処理', () => getActiveNotificationItemsForWebLocked_(testSpreadsheet, testStates));
}

function getActiveNotificationItemsForWebLocked_(testSpreadsheet, testStates) {
  const testMode = Boolean(testSpreadsheet || testStates) || isTestCaseModeEnabled_();
  const sheetsBySource = getNotificationReadSheets_(testSpreadsheet);
  let rows = getNotificationRowsFromSheets_(sheetsBySource, testMode);
  applyTestNotificationStatesToRows_(rows, testStates);

  rows = rows.filter(row => isTaskRelatedRow_(row));
  rows = rows.filter(row => String(row[12] || '') !== '完了');

  const data = rows.map(row => rowToNotificationItem_(row));

  return data;
}

function getNotificationRowsFromSheets_(sheetsBySource, testMode) {
  const rows = [];
  const useTestMode = typeof testMode === 'boolean' ? testMode : isTestCaseModeEnabled_();
  const testReferenceDate = useTestMode ? getTestCaseReferenceNow_() : null;

  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    const sheet = sheetsBySource && sheetsBySource[storageConfig.source];

    if (!sheet || sheet.getLastRow() < 2) {
      return;
    }

    const sourceRows = sheet.getDataRange().getValues().slice(1);
    const rowsForRead = useTestMode
      ? sourceRows.map(row => mapTestCaseNotificationRowForRead_(row, testReferenceDate))
      : sourceRows;
    const retainedRows = normalizeNotificationRowsForStorage_(rowsForRead, storageConfig);
    retainedRows.forEach(row => rows.push(...expandInCampusNotificationRow_(row)));
  });

  return rows;
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

function isStaleUnknownDueNotificationForWeb_(item) {
  if (item.dueType !== 'unknown') {
    return false;
  }

  if (!item.receivedAtTime) {
    return false;
  }

  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const deadline = item.receivedAtTime + ONE_WEEK_MS;

  return deadline < Date.now();
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

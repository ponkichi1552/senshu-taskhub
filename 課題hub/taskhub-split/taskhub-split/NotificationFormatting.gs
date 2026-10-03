function formatDateForWeb_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      'yyyy/MM/dd HH:mm'
    );
  }

  return String(value || '');
}

function normalizeDueInfoForWeb_(dueDateValue, dueStatusValue) {
  const dueStatus = String(dueStatusValue || '');
  const rawText = String(dueDateValue || '').trim();

  if (
    rawText === '期限なし' ||
    dueStatus.includes('期限なし')
  ) {
    return {
      dueDate: '期限なし',
      dueDateKey: '',
      dueTime: '',
      dueType: 'none'
    };
  }

  if (
    rawText === '' ||
    rawText === '期限未検出' ||
    dueStatus.includes('未検出')
  ) {
    return {
      dueDate: '期限未検出',
      dueDateKey: '',
      dueTime: '',
      dueType: 'unknown'
    };
  }

  if (dueDateValue instanceof Date) {
    const year = dueDateValue.getFullYear();
    const month = dueDateValue.getMonth() + 1;
    const day = dueDateValue.getDate();
    const hour = dueDateValue.getHours();
    const minute = dueDateValue.getMinutes();
    const hasTime = hour !== 0 || minute !== 0 || /Classroomで時刻補正|拡張機能で抽出|時刻あり/.test(dueStatus);

    return buildNormalizedDueInfo_(
      year,
      month,
      day,
      hasTime ? `${hour}:${minute}` : ''
    );
  }

  const parsed = parseDueDateTextForWeb_(rawText);

  if (parsed) {
    return parsed;
  }

  return {
    dueDate: '期限未検出',
    dueDateKey: '',
    dueTime: '',
    dueType: 'unknown'
  };
}

function parseDueDateTextForWeb_(text) {
  let match;

  match = String(text).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?$/);

  if (match) {
    return buildNormalizedDueInfo_(match[1], match[2], match[3], match[4]);
  }

  match = String(text).match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?$/);

  if (match) {
    return buildNormalizedDueInfo_(match[1], match[2], match[3], match[4]);
  }

  match = String(text).match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?$/);

  if (match) {
    return buildNormalizedDueInfo_(match[1], match[2], match[3], match[4]);
  }

  match = String(text).match(/^(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?$/);

  if (match) {
    const year = new Date().getFullYear();
    return buildNormalizedDueInfo_(year, match[1], match[2], match[3]);
  }

  return null;
}

function buildNormalizedDueInfo_(year, month, day, timeText) {
  let yearNum = Number(year);
  let monthNum = Number(month);
  let dayNum = Number(day);

  if (!isValidDateParts_(yearNum, monthNum, dayNum)) {
    return {
      dueDate: '期限未検出',
      dueDateKey: '',
      dueTime: '',
      dueType: 'unknown'
    };
  }

  let time = normalizeTimeText_(timeText);
  if (time === '00:00') {
    const priorDay = new Date(yearNum, monthNum - 1, dayNum - 1);
    yearNum = priorDay.getFullYear(); monthNum = priorDay.getMonth() + 1; dayNum = priorDay.getDate();
    time = '23:59';
  }
  const y = String(yearNum);
  const m = String(monthNum).padStart(2, '0');
  const d = String(dayNum).padStart(2, '0');

  return {
    dueDate: time ? `${y}/${m}/${d} ${time}` : `${y}/${m}/${d}`,
    dueDateKey: `${y}-${m}-${d}`,
    dueTime: time,
    dueType: 'detected'
  };
}

function isValidDateParts_(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }

  if (month < 1 || month > 12) {
    return false;
  }

  if (day < 1 || day > 31) {
    return false;
  }

  const date = new Date(year, month - 1, day);

  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;
}

function normalizeTimeText_(timeText) {
  if (!timeText) {
    return '';
  }

  const parts = String(timeText).split(':');

  if (parts.length !== 2) {
    return '';
  }

  const hour = Number(parts[0]);
  const minute = Number(parts[1]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return '';
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function refreshAndGetNotificationsForWeb() {
  // Gmail scanning can take much longer than a sheet read. The ingestion
  // function now locks only its setup/commit phases, so this request must not
  // wrap the full scan in another user lock.
  saveClassroomMailsToSheet();
  return getNotificationsForWeb();
}

function syncAndGetNotificationsForWeb() {
  // Test mode changes only which sheet is displayed. Gmail mail is still
  // committed to the signed-in user's original private spreadsheet.
  const syncResult = saveClassroomMailsToSheet();
  return {
    items: getNotificationsForWeb(),
    testCaseModeEnabled: isTestCaseModeEnabled_(),
    syncSkipped: Boolean(syncResult.skipped),
    syncSkipReason: String(syncResult.reason || ''),
    savedCount: Number(syncResult.savedCount || 0),
    classroomSavedCount: Number(syncResult.classroomSavedCount || 0),
    inCampusSavedCount: Number(syncResult.inCampusSavedCount || 0),
    autoCompletedCount: Number(syncResult.autoCompletedCount || 0),
    completedAt: new Date().toISOString()
  };
}

function clearNotificationSheetData_() {
  return runWithUserLock_('保存データ処理', () => clearNotificationSheetDataLocked_());
}

function clearNotificationSheetDataLocked_() {
  if (isTestCaseModeEnabled_()) {
    throw new Error('テストケース適用中はテストデータを消去できません。設定をOFFにしてから実行してください。');
  }
  const ss = getOrCreateSpreadsheet_();
  const sheetsBySource = ensureNotificationStorage_(ss);

  NOTIFICATION_STORAGE_CONFIGS.forEach(storageConfig => {
    const sheet = sheetsBySource[storageConfig.source];

    if (!sheet || sheet.getLastRow() <= 1) {
      return;
    }

    sheet
      .getRange(2, 1, sheet.getLastRow() - 1, HEADER_ROW.length)
      .clearContent();
  });

  SpreadsheetApp.flush();
}

function rebuildAndGetNotificationsForWeb() {
  // Kept as a compatibility endpoint; rebuilding by clearing the workbook
  // would force an unnecessary wide Gmail scan. Reuse the normal watermark.
  saveClassroomMailsToSheet();
  return getNotificationsForWeb();
}

function rebuildAndGetNotificationsForWebLocked_() {
  throw new Error('増分同期は共有ロックの外側から実行してください。');
}

function ensureAutoFetchTrigger_() {
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === AUTO_FETCH_HANDLER);
  const props = PropertiesService.getUserProperties();
  const configuredRevision = props.getProperty(AUTO_FETCH_TRIGGER_REVISION_PROPERTY);

  if (matchingTriggers.length > 0 && configuredRevision === AUTO_FETCH_TRIGGER_REVISION) {
    matchingTriggers.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));

    return {
      created: false,
      removedDuplicates: Math.max(0, matchingTriggers.length - 1)
    };
  }

  // Existing triggers can remain pinned to an older code version. Create the
  // replacement first so a creation error never leaves the user without sync.
  const replacement = ScriptApp.newTrigger(AUTO_FETCH_HANDLER)
    .timeBased()
    .everyMinutes(15)
    .create();
  matchingTriggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  props.setProperty(AUTO_FETCH_TRIGGER_REVISION_PROPERTY, AUTO_FETCH_TRIGGER_REVISION);

  return {
    created: true,
    replacedExisting: matchingTriggers.length > 0,
    removedDuplicates: Math.max(0, matchingTriggers.length - 1),
    replacementId: replacement.getUniqueId ? replacement.getUniqueId() : ''
  };
}

function setupAutoFetchTrigger() {
  return runWithUserLock_('保存データ処理', () => setupAutoFetchTriggerLocked_());
}

function setupAutoFetchTriggerLocked_() {
  const result = ensureAutoFetchTrigger_();

  Logger.log(result.created
    ? '15分ごとの自動取得トリガーを作成しました。'
    : '自動取得トリガーは設定済みです。');

  return result;
}

function deleteAutoFetchTrigger() {
  return runWithUserLock_('保存データ処理', () => deleteAutoFetchTriggerLocked_());
}

function deleteAutoFetchTriggerLocked_() {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === AUTO_FETCH_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  Logger.log('自動取得トリガーを削除しました。');
}

function markNotificationDone(messageId) {
  return updateNotificationStatus_(messageId, '完了', getNotificationsForWeb);
}

function markNotificationUndone(messageId) {
  return updateNotificationStatus_(messageId, '未確認', getCompletedNotificationsForWeb);
}

function updateNotificationStatus_(messageId, status, responseBuilder) {
  return runWithUserLock_('保存データ処理', () => updateNotificationStatusLocked_(messageId, status, responseBuilder));
}

function updateNotificationStatusLocked_(messageId, status, responseBuilder) {
  const targetMessageId = String(messageId || '');

  if (!targetMessageId) {
    return responseBuilder();
  }

  if (isTestCaseModeEnabled_()) {
    saveTestNotificationState_(targetMessageId, status);
    return responseBuilder();
  }

  if (targetMessageId.startsWith('incampus:')) {
    updateInCampusExtractedStatus_(targetMessageId, status);
    return responseBuilder();
  }

  const ss = getOrCreateSpreadsheet_();
  const sheetsBySource = ensureNotificationStorage_(ss);
  let updated = false;

  for (const storageConfig of NOTIFICATION_STORAGE_CONFIGS) {
    const sheet = sheetsBySource[storageConfig.source];

    if (!sheet || sheet.getLastRow() < 2) {
      continue;
    }

    const values = sheet.getDataRange().getValues();
    const logicalTarget = findInCampusLogicalRecordById_(values, targetMessageId);
    if (logicalTarget) {
      setInCampusLogicalRecordStatus_(sheet, values, logicalTarget, status, new Date());
      updated = true;
      break;
    }

    for (let i = 1; i < values.length; i++) {
      const rowMessageId = String(values[i][1] || '');

      if (rowMessageId !== targetMessageId) {
        continue;
      }

      if (storageConfig.source === 'inCampus') {
        const records = extractInCampusMailRecords_(values[i][7], values[i][11], values[i][9]);
        const child = expandInCampusNotificationRow_(values[i])[getLegacyInCampusRecordIndex_(values[i], records)];
        if (child) {
          setInCampusLogicalRecordStatus_(sheet, values, {index: i, row: child}, status, new Date());
          updated = true;
          break;
        }
      }
      const sheetRow = i + 1;
      sheet.getRange(sheetRow, 13).setValue(status);

      if (status === '完了') {
        sheet.getRange(sheetRow, 14).setValue(new Date());
      } else {
        sheet.getRange(sheetRow, 14).clearContent();
      }

      SpreadsheetApp.flush();
      updated = true;
      break;
    }

    if (updated) {
      break;
    }
  }

  return responseBuilder();
}

function cleanBodyForWeb_(body, source) {
  const rawText = String(body || '');

  if (source === 'Google Classroom') {
    return cleanClassroomBodyForWeb_(rawText);
  }

  return cleanCommonEmailBodyForWeb_(rawText);
}

function cleanClassroomBodyForWeb_(body) {
  const text = removeEmailFooterForWeb_(body);
  const lines = getCleanLines_(text);

  const cleanedLines = lines.filter(line => {
    const currentLine = String(line || '').trim();

    if (currentLine === '') {
      return false;
    }

    if (isClassroomUrlOrWrappedUrlLine_(currentLine)) {
      return false;
    }

    if (currentLine === '通知設定') {
      return false;
    }

    if (currentLine === '詳細を表示') {
      return false;
    }

    if (currentLine === '課題を表示') {
      return false;
    }

    if (currentLine === '成績を表示') {
      return false;
    }

    if (currentLine === '返信') {
      return false;
    }

    if (currentLine.includes('Google LLC')) {
      return false;
    }

    if (currentLine.includes('このメールは、Google Classroom')) {
      return false;
    }

    if (currentLine.includes('配信停止')) {
      return false;
    }

    if (currentLine.includes('設定の変更')) {
      return false;
    }

    if (currentLine.includes('accounts.google.com')) {
      return false;
    }

    return true;
  });

  return cleanedLines.join('\n');
}

function cleanCommonEmailBodyForWeb_(body) {
  return removeEmailFooterForWeb_(body).trim();
}

function removeEmailFooterForWeb_(body) {
  const text = String(body || '');

  const footerMarkers = [
    'Google LLC 1600 Amphitheatre Parkway',
    'このメールは、Google Classroom',
    '配信停止または設定の変更'
  ];

  let cutIndex = -1;

  footerMarkers.forEach(marker => {
    const index = text.indexOf(marker);

    if (index >= 0 && (cutIndex === -1 || index < cutIndex)) {
      cutIndex = index;
    }
  });

  if (cutIndex >= 0) {
    return text.slice(0, cutIndex).trim();
  }

  return text.trim();
}

function rowToNotificationItem_(row) {
  const dueInfo = normalizeDueInfoForWeb_(row[5], row[6]);
  const receivedAtTime = getTimeForSort_(row[9]);
  const completedAtTime = getTimeForSort_(row[13]);
  const source = String(row[2] || '');
  const body = String(row[11] || '');

  return {
    savedAt: formatDateForWeb_(row[0]),
    messageId: row[1],
    source: row[2],
    courseName: row[3],
    title: source === 'inCampus' ? extractInCampusTitle_(row[7], body) : (row[4] && row[4] !== 'タイトル未抽出' ? row[4] : row[7]),
    weekdayPeriod: (extractRequiredInCampusFieldsFromBody_(body) || {}).weekdayPeriod || '',

    dueDate: dueInfo.dueDate,
    dueDateKey: dueInfo.dueDateKey,
    dueTime: dueInfo.dueTime,
    dueType: dueInfo.dueType,

    dueStatus: row[6],
    subject: row[7],
    from: row[8],
    receivedAt: formatDateForWeb_(row[9]),
    receivedAtTime: receivedAtTime,
    gmailLink: row[10],
    classroomUrl: extractClassroomUrl_(source, body),
    body: cleanBodyForWeb_(body, source),
    status: row[12],
    completedAt: formatDateForWeb_(row[13]),
    completedAtTime: completedAtTime
  };
}

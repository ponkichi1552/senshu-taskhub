const CLASSROOM_COURSE_HEADERS = [
  '授業ID', '授業名', '区分', '教員名', '授業URL', '状態', '最終取得日時'
];

const CLASSROOM_COURSEWORK_HEADERS = [
  '授業ID', '課題ID', '授業名', 'タイトル', '説明', '課題種別', '対象者種別',
  '添付リンク', 'トピックID', 'トピック名', '公開日時', '作成日時', '最終更新日時',
  '期限日', '期限時刻', '期限時刻の根拠', 'Classroom URL', '最終取得日時',
  'TaskHub確認状態', 'TaskHub完了日時', '状態更新元'
];

const CLASSROOM_SUBMISSION_HEADERS = [
  '授業ID', '課題ID', '授業名', '課題名', '提出状態', '提出日時',
  '遅延', '返却済み', '公開済み点数', '最終更新日時'
];

function ensureClassroomStructuredStorageLocked_(ss) {
  const spreadsheet = ss || getOrCreateSpreadsheet_();
  return {
    courses: getOrCreateStructuredSheet_(spreadsheet, CONFIG.CLASSROOM_COURSES_SHEET_NAME, CLASSROOM_COURSE_HEADERS),
    coursework: getOrCreateStructuredSheet_(spreadsheet, CONFIG.CLASSROOM_COURSEWORK_SHEET_NAME, CLASSROOM_COURSEWORK_HEADERS),
    submissions: getOrCreateStructuredSheet_(spreadsheet, CONFIG.CLASSROOM_SUBMISSIONS_SHEET_NAME, CLASSROOM_SUBMISSION_HEADERS)
  };
}

function removeEmptyDefaultSheetsLocked_(spreadsheet) {
  if (!spreadsheet || typeof spreadsheet.getSheets !== 'function' || typeof spreadsheet.deleteSheet !== 'function') return 0;
  const defaultNames = new Set(['Sheet1', 'シート1']);
  let removed = 0;
  spreadsheet.getSheets().slice().forEach(sheet => {
    if (!defaultNames.has(sheet.getName()) || spreadsheet.getSheets().length <= 1) return;
    const hasContent = sheet.getDataRange().getValues().some(row =>
      row.some(value => value !== '' && value !== null && value !== undefined)
    );
    if (hasContent) return;
    spreadsheet.deleteSheet(sheet);
    removed++;
  });
  return removed;
}

function getOrCreateStructuredSheet_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (headers.some((header, index) => current[index] !== header)) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function replaceStructuredSheetRows_(sheet, headers, rows) {
  const safeRows = rows.map(row => {
    if (!Array.isArray(row) || row.length !== headers.length) {
      throw new Error(`「${sheet.getName()}」の保存列数が見出しと一致しません。`);
    }
    return toSafeSpreadsheetRow_(row);
  });
  const oldCount = Math.max(0, sheet.getLastRow() - 1);
  if (safeRows.length) sheet.getRange(2, 1, safeRows.length, headers.length).setValues(safeRows);
  if (safeRows.length && sheet.getName() === CONFIG.CLASSROOM_COURSEWORK_SHEET_NAME) {
    sheet.getRange(2, getClassroomCourseworkColumn_('期限日') + 1, safeRows.length, 1).setNumberFormat('yyyy/MM/dd');
    sheet.getRange(2, getClassroomCourseworkColumn_('期限時刻') + 1, safeRows.length, 1).setNumberFormat('HH:mm');
  }
  if (oldCount > safeRows.length) {
    sheet.getRange(safeRows.length + 2, 1, oldCount - safeRows.length, headers.length).clearContent();
  }
}

function getStructuredSheetRows_(sheet, columnCount) {
  return sheet && sheet.getLastRow() >= 2
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, columnCount).getValues()
    : [];
}

function getClassroomCourseworkColumn_(name) {
  return CLASSROOM_COURSEWORK_HEADERS.indexOf(name);
}

function formatClassroomStoredDateValue_(value, format) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), format);
  }

  const raw = String(value || '').trim();
  if (!raw) return '';

  if (format === 'yyyy/MM/dd') {
    const match = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (match) return `${match[1]}/${String(match[2]).padStart(2, '0')}/${String(match[3]).padStart(2, '0')}`;
  }
  if (format === 'HH:mm') {
    const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (match) return `${String(match[1]).padStart(2, '0')}:${match[2]}`;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? raw
    : Utilities.formatDate(parsed, Session.getScriptTimeZone(), format);
}

function getClassroomCourseworkKey_(courseId, courseworkId) {
  return `${String(courseId || '').trim()}\u001f${String(courseworkId || '').trim()}`;
}

function getClassroomApiNotificationRowsForWeb_() {
  const spreadsheet = getOrCreateSpreadsheet_();
  const hasStructuredSnapshot = Boolean(
    PropertiesService.getUserProperties().getProperty(CLASSROOM_API_STRUCTURED_SYNC_PROPERTY)
  );
  if (!hasStructuredSnapshot ||
      PropertiesService.getUserProperties().getProperty(CLASSROOM_API_STRUCTURED_SYNC_IN_PROGRESS_PROPERTY) === 'true') {
    return getLegacyClassroomApiNotificationRows_(spreadsheet);
  }

  const courseworkSheet = spreadsheet.getSheetByName(CONFIG.CLASSROOM_COURSEWORK_SHEET_NAME);
  const submissionsSheet = spreadsheet.getSheetByName(CONFIG.CLASSROOM_SUBMISSIONS_SHEET_NAME);
  if (!courseworkSheet || courseworkSheet.getLastRow() < 2) return [];

  const taskRows = courseworkSheet.getDataRange().getValues().slice(1);
  const submissionByKey = new Map();
  if (submissionsSheet && submissionsSheet.getLastRow() >= 2) {
    submissionsSheet.getDataRange().getValues().slice(1).forEach(row => {
      submissionByKey.set(getClassroomCourseworkKey_(row[0], row[1]), row);
    });
  }

  const column = name => getClassroomCourseworkColumn_(name);
  return taskRows.map(task => {
    const courseId = String(task[column('授業ID')] || '');
    const courseworkId = String(task[column('課題ID')] || '');
    const submission = submissionByKey.get(getClassroomCourseworkKey_(courseId, courseworkId)) || [];
    const dueDate = formatClassroomStoredDateValue_(task[column('期限日')], 'yyyy/MM/dd');
    const dueTime = formatClassroomStoredDateValue_(task[column('期限時刻')], 'HH:mm');
    const description = String(task[column('説明')] || '').slice(0, CONFIG.BODY_LIMIT);
    const link = String(task[column('Classroom URL')] || '');
    const receivedAt = getClassroomApiCourseworkDeliveryDate_(
      null,
      task,
      task[column('最終取得日時')] || new Date()
    );
    const body = [description, link].filter(Boolean).join('\n\n');
    return toSafeSpreadsheetRow_([
      task[column('最終取得日時')] || receivedAt,
      buildClassroomApiMessageId_(courseId, courseworkId),
      'Google Classroom',
      String(task[column('授業名')] || ''),
      String(task[column('タイトル')] || '(課題名なし)'),
      dueDate ? `${dueDate}${dueTime ? ` ${dueTime}` : ''}` : '期限なし',
      dueDate ? 'Classroom API' : String(task[column('期限時刻の根拠')] || '期限なし（Classroom API）'),
      String(task[column('タイトル')] || '(課題名なし)'),
      'Google Classroom API',
      receivedAt,
      link,
      body,
      String(task[column('TaskHub確認状態')] || '未確認'),
      task[column('TaskHub完了日時')] || '',
      String(task[column('状態更新元')] || 'classroom-api-submission'),
      String(submission[4] || ''),
      ''
    ]);
  });
}

function getLegacyClassroomApiNotificationRows_(spreadsheet) {
  const legacySheet = spreadsheet.getSheetByName(CONFIG.CLASSROOM_SHEET_NAME);
  if (!legacySheet || legacySheet.getLastRow() < 2) return [];
  return legacySheet.getDataRange().getValues().slice(1)
    .filter(row => isClassroomApiManagedRow_(row))
    .map(row => normalizeNotificationRowWidth_(row));
}

function migrateLegacyClassroomNotificationRowsLocked_(spreadsheet, destinationSheet) {
  const props = PropertiesService.getUserProperties();
  const marker = String(spreadsheet.getId ? spreadsheet.getId() : 'default');
  if (props.getProperty(LEGACY_CLASSROOM_NOTICE_MIGRATION_PROPERTY) === marker) return 0;

  const legacySheet = spreadsheet.getSheetByName(CONFIG.CLASSROOM_SHEET_NAME);
  if (!legacySheet || legacySheet.getLastRow() < 2) {
    props.setProperty(LEGACY_CLASSROOM_NOTICE_MIGRATION_PROPERTY, marker);
    return 0;
  }

  const savedIds = getSavedMessageIds_(destinationSheet);
  const rows = legacySheet.getDataRange().getValues().slice(1)
    .filter(row => String(row[2] || '') === 'Google Classroom')
    .filter(row => !isClassroomApiManagedRow_(row) && !isClassroomExtensionSyncRow_(row))
    .filter(row => {
      const id = String(row[1] || '').trim();
      if (!id || savedIds.has(id)) return false;
      savedIds.add(id);
      return true;
    })
    .map(row => normalizeNotificationRowWidth_(row));
  appendNotificationRows_(destinationSheet, rows);
  props.setProperty(LEGACY_CLASSROOM_NOTICE_MIGRATION_PROPERTY, marker);
  return rows.length;
}

function updateClassroomApiTaskUserStatus_(messageId, status, completedAt) {
  const match = String(messageId || '').match(/^classroom-api:([^:]+):(.+)$/);
  if (!match) return false;
  const spreadsheet = getOrCreateSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(CONFIG.CLASSROOM_COURSEWORK_SHEET_NAME);
  if (sheet && sheet.getLastRow() >= 2) {
    const values = sheet.getDataRange().getValues();
    const courseColumn = getClassroomCourseworkColumn_('授業ID');
    const taskColumn = getClassroomCourseworkColumn_('課題ID');
    const statusColumn = getClassroomCourseworkColumn_('TaskHub確認状態');
    const completedColumn = getClassroomCourseworkColumn_('TaskHub完了日時');
    const sourceColumn = getClassroomCourseworkColumn_('状態更新元');
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][courseColumn] || '') !== match[1] || String(values[i][taskColumn] || '') !== match[2]) continue;
      sheet.getRange(i + 1, statusColumn + 1, 1, 3).setValues([[
        status,
        status === '完了' ? (completedAt || new Date()) : '',
        'manual-status'
      ]]);
      return true;
    }
  }

  // Keep already-deployed workbooks usable until their first structured API snapshot succeeds.
  if (PropertiesService.getUserProperties().getProperty(CLASSROOM_API_STRUCTURED_SYNC_PROPERTY)) return false;
  const legacySheet = spreadsheet.getSheetByName(CONFIG.CLASSROOM_SHEET_NAME);
  if (!legacySheet || legacySheet.getLastRow() < 2) return false;
  const values = legacySheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][1] || '') !== messageId) continue;
    legacySheet.getRange(i + 1, 13, 1, 3).setValues([
      [status, status === '完了' ? (completedAt || new Date()) : '', 'manual-status']
    ]);
    return true;
  }
  return false;
}

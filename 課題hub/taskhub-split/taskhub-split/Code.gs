const CONFIG = {
  SHEET_NAME: '通知一覧',
  QUERY: '(from:classroom.google.com OR from:no-reply-incampus@isc.senshu-u.ac.jp) newer_than:30d',
  MAX_THREADS: 100,
  LOOKBACK_DAYS: 30,
  BODY_LIMIT: 5000
};

const HEADER_ROW = [
  '保存日時',
  'メッセージID',
  '通知元',
  '授業名',
  '課題・通知タイトル',
  '期限',
  '期限状態',
  'メール件名',
  '送信者',
  '受信日時',
  'Gmailリンク',
  '本文',
  '確認状態',
  '完了日時'
];

const TASK_KEYWORDS = [
  '課題',
  '宿題',
  'レポート',
  '小テスト',
  'リフレクション',
  '演習',
  '提出',
  'アンケート',
  '予習',
  '復習',
  'ワーク',
  '確認テスト',
  'アクティビティ'
];

const ANNOUNCEMENT_TASK_KEYWORDS = [
  '課題',
  '宿題',
  'レポート',
  '提出',
  '小テスト',
  'リフレクション',
  '予習',
  '復習',
  '確認テスト',
  'アクティビティ'
];

function doGet() {
  ensureUserStorageForWeb_();

  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle('課題通知Hub');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function ensureUserStorageForWeb_() {
  try {
    const ss = getOrCreateSpreadsheet_();

    setupHeader_(getOrCreateSheet_(ss));
    getOrCreateInCampusSheet_();

    return {
      ok: true,
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl()
    };
  } catch (error) {
    Logger.log('ユーザー用スプレッドシート初期化に失敗: ' + (error && error.message ? error.message : error));

    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function detectSource_(from) {
  const text = String(from || '').toLowerCase();

  if (text.includes('classroom.google.com')) {
    return 'Google Classroom';
  }

  if (text.includes('no-reply-incampus@isc.senshu-u.ac.jp')) {
    return 'inCampus';
  }

  return 'その他';
}

function isWithinLookback_(date, days) {
  if (!(date instanceof Date) || !Number.isInteger(days) || days <= 0) {
    return true;
  }

  const earliest = new Date();
  earliest.setDate(earliest.getDate() - days);
  earliest.setHours(0, 0, 0, 0);

  return date.getTime() >= earliest.getTime();
}

function saveClassroomMailsToSheet() {
  return runWithUserLock_('メール保存処理', saveClassroomMailsToSheetLocked_);
}

function runWithUserLock_(label, callback) {
  const lock = LockService.getUserLock();
  let hasLock = false;

  try {
    if (!lock.tryLock(5000)) {
      throw new Error((label || '処理') + 'が混み合っています。少し待ってから再実行してください。');
    }

    hasLock = true;
    return callback();
  } finally {
    if (hasLock) {
      lock.releaseLock();
    }
  }
}

function saveClassroomMailsToSheetLocked_() {
  const ss = getOrCreateSpreadsheet_();
  const sheet = getOrCreateSheet_(ss);

  setupHeader_(sheet);

  const savedMessageIds = getSavedMessageIds_(sheet);
  const threads = GmailApp.search(CONFIG.QUERY, 0, CONFIG.MAX_THREADS);

  let savedCount = 0;

  threads.forEach(thread => {
    const messages = thread.getMessages();

    if (!messages || messages.length === 0) {
      return;
    }

    const gmailLink = thread.getPermalink();

    messages.forEach(message => {
      const messageId = String(message.getId() || '');

      if (!messageId || savedMessageIds.has(messageId)) {
        return;
      }

      const from = message.getFrom();
      const source = detectSource_(from);

      if (source === 'その他') {
        return;
      }

      const receivedDate = message.getDate();

      if (!isWithinLookback_(receivedDate, CONFIG.LOOKBACK_DAYS)) {
        return;
      }

      const subject = message.getSubject();
      const body = message.getPlainBody() || '';
      const submissionRecords = source === 'inCampus'
        ? extractInCampusSubmissionRecords_(subject, body)
        : [];

      if (submissionRecords.length > 0) {
        const firstRecord = submissionRecords[0];

        sheet.appendRow(toSafeSpreadsheetRow_([
          new Date(),
          messageId,
          source,
          firstRecord.courseName || extractInCampusCourseName_(body),
          firstRecord.title || subject,
          '',
          '提出記録',
          subject,
          from,
          receivedDate,
          gmailLink,
          body.slice(0, CONFIG.BODY_LIMIT),
          '完了記録',
          firstRecord.submittedAt || receivedDate
        ]));

        savedMessageIds.add(messageId);
        savedCount++;
        return;
      }

      const extracted = extractNotificationInfo_(source, subject, body, receivedDate);

      sheet.appendRow(toSafeSpreadsheetRow_([
        new Date(),
        messageId,
        source,
        extracted.courseName,
        extracted.title,
        extracted.dueDate,
        extracted.dueStatus,
        subject,
        from,
        receivedDate,
        gmailLink,
        body.slice(0, CONFIG.BODY_LIMIT),
        '未確認',
        ''
      ]));

      savedMessageIds.add(messageId);
      savedCount++;
    });
  });

  const autoCompletedCount = applySavedInCampusSubmissionRecords_(sheet);

  Logger.log('保存件数: ' + savedCount);
  Logger.log('inCampus提出記録による自動完了件数: ' + autoCompletedCount);
  Logger.log('スプレッドシートURL: ' + ss.getUrl());

  return {
    savedCount,
    autoCompletedCount,
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl()
  };
}

function getOrCreateSpreadsheet_() {
  const configuredId = getConfiguredSpreadsheetId_();

  if (configuredId) {
    return SpreadsheetApp.openById(configuredId);
  }

  const props = PropertiesService.getUserProperties();
  const savedId = props.getProperty(USER_SPREADSHEET_ID_PROPERTY) ||
    props.getProperty(LEGACY_SPREADSHEET_ID_PROPERTY);

  if (savedId) {
    try {
      const ss = SpreadsheetApp.openById(savedId);
      props.setProperty(USER_SPREADSHEET_ID_PROPERTY, ss.getId());

      return ss;
    } catch (error) {
      props.deleteProperty(USER_SPREADSHEET_ID_PROPERTY);
      props.deleteProperty(LEGACY_SPREADSHEET_ID_PROPERTY);
      Logger.log('保存済みスプレッドシートを開けなかったため再作成します: ' + error.message);
    }
  }

  const ss = SpreadsheetApp.create('課題通知Hub_保存データ');
  props.setProperty(USER_SPREADSHEET_ID_PROPERTY, ss.getId());

  return ss;
}

function getConfiguredSpreadsheetId_() {
  if (typeof DEFAULT_SPREADSHEET_ID !== 'undefined' && DEFAULT_SPREADSHEET_ID) {
    return String(DEFAULT_SPREADSHEET_ID).trim();
  }

  return '';
}

function getOrCreateSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }

  return sheet;
}

function setupHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER_ROW);
  } else {
    sheet.getRange(1, 1, 1, HEADER_ROW.length).setValues([HEADER_ROW]);
  }

  sheet.setFrozenRows(1);

  const lastColumn = Math.max(sheet.getLastColumn(), HEADER_ROW.length);

  if (lastColumn > 0) {
    sheet.autoResizeColumns(1, lastColumn);
  }
}

function getSavedMessageIds_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return new Set();
  }

  const values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const ids = values
    .map(row => String(row[0] || '').trim())
    .filter(id => id !== '');

  return new Set(ids);
}

function extractNotificationInfo_(source, subject, body, receivedDate) {
  const dueInfo = extractDueDate_(`${subject}\n${body}`, receivedDate);

  if (source === 'inCampus') {
    return {
      courseName: extractInCampusCourseName_(body),
      title: extractInCampusTitle_(subject, body),
      dueDate: dueInfo.dueDate,
      dueStatus: dueInfo.dueStatus
    };
  }

  const courseName = extractCourseName_(body);
  const title = extractTitle_(subject, body);

  return {
    courseName,
    title,
    dueDate: dueInfo.dueDate,
    dueStatus: dueInfo.dueStatus
  };
}

function extractInCampusCourseName_(body) {
  const lines = getCleanLines_(body);
  const courseLine = lines.find(line => /^授業名\s*[:：]/.test(line));

  if (!courseLine) {
    return 'inCampusお知らせ';
  }

  const courseName = courseLine.replace(/^授業名\s*[:：]\s*/, '').trim();

  return courseName || 'inCampusお知らせ';
}

function extractInCampusTitle_(subject, body) {
  const updateLines = getInCampusUpdateLines_(body);

  for (const line of updateLines) {
    const title = extractInCampusAddedItemTitle_(line);

    if (title) {
      return title;
    }
  }

  return subject || 'タイトル未抽出';
}

function getInCampusUpdateLines_(body) {
  const lines = getCleanLines_(body);
  const markerIndex = lines.findIndex(line => /^更新内容\s*[:：]/.test(line));

  if (markerIndex === -1) {
    return lines;
  }

  return lines.slice(markerIndex + 1);
}

function extractInCampusAddedItemTitle_(line) {
  const text = String(line || '').trim();
  const patterns = [
    /[・\s]*(課題|お知らせ|教材|資料)\s*[（(](.+?)[）)]\s*が追加されました/,
    /[・\s]*(課題|お知らせ|教材|資料)\s*[「『]([^」』]+)[」』]\s*が追加されました/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match) {
      continue;
    }

    const itemType = String(match[1] || '').trim();
    const title = String(match[2] || '').trim();

    if (!title) {
      return '';
    }

    if (itemType === '課題') {
      return title;
    }

    if (TASK_KEYWORDS.some(keyword => title.includes(keyword))) {
      return title;
    }
  }

  return '';
}

function isInCampusTaskRelated_(subject, body) {
  const text = `${subject || ''}\n${body || ''}`;

  if (isNonActionableNotification_(text)) {
    return false;
  }

  const lines = getInCampusUpdateLines_(body);

  return lines.some(line => extractInCampusAddedItemTitle_(line) !== '');
}

function extractInCampusSubmissionRecords_(subject, body) {
  const lines = getCleanLines_(`${subject || ''}\n${body || ''}`);
  const records = [];

  lines.forEach((line, index) => {
    const title = extractInCampusSubmittedItemTitle_(line);

    if (!title) {
      return;
    }

    const courseName = findInCampusSubmissionCourseName_(lines, index);
    const submittedAt = extractDateTimeFromInCampusLine_(line);

    records.push({
      courseName,
      title,
      submittedAt
    });
  });

  return records;
}

function extractInCampusSubmittedItemTitle_(line) {
  const text = String(line || '').trim();
  const patterns = [
    /[・\s]*課題\s*[（(](.+?)[）)]\s*を提出しました/,
    /[・\s]*課題\s*[「『]([^」』]+)[」』]\s*を提出しました/,
    /[・\s]*課題\s*[（(](.+?)[）)]\s*が提出されました/,
    /[・\s]*課題\s*[「『]([^」』]+)[」』]\s*が提出されました/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match) {
      continue;
    }

    const title = String(match[1] || '').trim();

    if (title) {
      return title;
    }
  }

  return '';
}

function findInCampusSubmissionCourseName_(lines, lineIndex) {
  for (let i = lineIndex - 1; i >= 0; i--) {
    const line = String(lines[i] || '').trim();

    if (!line) {
      continue;
    }

    const courseName = extractInCampusCourseNameFromBracketLine_(line);

    if (courseName) {
      return courseName;
    }

    if (/^授業名\s*[:：]/.test(line)) {
      return line.replace(/^授業名\s*[:：]\s*/, '').trim();
    }

    if (extractInCampusSubmittedItemTitle_(line)) {
      break;
    }
  }

  return '';
}

function extractInCampusCourseNameFromBracketLine_(line) {
  const text = String(line || '').trim();
  const match = text.match(/^\[([^\]]+)\]$/);

  if (!match) {
    return '';
  }

  const courseName = String(match[1] || '')
    .replace(/^[月火水木金土日]\d+\s*/, '')
    .trim();

  return courseName;
}

function extractDateTimeFromInCampusLine_(line) {
  const text = String(line || '');
  const match = text.match(/(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/);

  if (!match) {
    return '';
  }

  const date = new Date(match[1]);

  return Number.isNaN(date.getTime()) ? match[1] : date;
}

function applySavedInCampusSubmissionRecords_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) {
    return 0;
  }

  const values = sheet.getDataRange().getValues();
  let completedCount = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const source = String(row[2] || '');

    if (source !== 'inCampus') {
      continue;
    }

    const records = extractInCampusSubmissionRecords_(row[7], row[11]);

    records.forEach(record => {
      if (completeMatchingInCampusMailRow_(sheet, record, row[9])) {
        completedCount++;
      }
    });
  }

  return completedCount;
}

function completeMatchingInCampusMailRow_(sheet, record, fallbackCompletedAt) {
  if (!record || !record.title || !sheet || sheet.getLastRow() < 2) {
    return false;
  }

  const values = sheet.getDataRange().getValues();
  const recordTitle = normalizeInCampusMatchText_(record.title);
  const recordCourseName = normalizeInCampusCourseNameForMatch_(record.courseName);

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const source = String(row[2] || '');
    const dueStatus = String(row[6] || '');
    const status = String(row[12] || '');

    if (source !== 'inCampus' || dueStatus === '提出記録' || status === '完了') {
      continue;
    }

    const rowTitle = normalizeInCampusMatchText_(row[4]);
    const rowCourseName = normalizeInCampusCourseNameForMatch_(row[3]);
    const titleMatches = rowTitle &&
      recordTitle &&
      (rowTitle === recordTitle ||
      rowTitle.includes(recordTitle) ||
      recordTitle.includes(rowTitle));
    const courseMatches = !recordCourseName ||
      !rowCourseName ||
      rowCourseName === 'incampusお知らせ' ||
      rowCourseName === recordCourseName ||
      rowCourseName.includes(recordCourseName) ||
      recordCourseName.includes(rowCourseName);

    if (!titleMatches || !courseMatches) {
      continue;
    }

    const sheetRow = i + 1;
    sheet.getRange(sheetRow, 13).setValue('完了');
    sheet.getRange(sheetRow, 14).setValue(toSafeSpreadsheetCell_(record.submittedAt || fallbackCompletedAt || new Date()));
    SpreadsheetApp.flush();

    return true;
  }

  return false;
}

function normalizeInCampusMatchText_(value) {
  return normalizeTextWidth_(value)
    .replace(/[（）]/g, character => character === '（' ? '(' : ')')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function normalizeTextWidth_(value) {
  const text = String(value || '');

  return typeof text.normalize === 'function'
    ? text.normalize('NFKC')
    : text;
}

function normalizeInCampusCourseNameForMatch_(value) {
  return normalizeInCampusMatchText_(
    String(value || '').replace(/^[月火水木金土日]\d+/, '')
  );
}

function extractClassroomUrl_(source, body) {
  if (source !== 'Google Classroom') {
    return '';
  }

  const candidates = extractClassroomUrlCandidates_(body);
  const assignmentUrl = candidates.find(url => isClassroomAssignmentUrl_(url));

  return assignmentUrl || candidates[0] || '';
}

function extractClassroomUrlCandidates_(body) {
  const content = removeEmailFooterForUrlExtraction_(body);
  const lines = String(content || '')
    .split(/\r?\n/)
    .map(line => line.trim());
  const candidates = [];
  const seen = {};
  const addCandidate = value => {
    const normalizedUrl = normalizeClassroomUrlForMatch_(value);

    if (!normalizedUrl || seen[normalizedUrl]) {
      return;
    }

    seen[normalizedUrl] = true;
    candidates.push(normalizedUrl);
  };
  const markerTexts = [
    '詳細を表示',
    '課題を表示',
    '返信'
  ];

  for (const markerText of markerTexts) {
    const url = getClassroomUrlFromNextLine_(lines, markerText);

    if (url) {
      addCandidate(url);
    }
  }

  for (const line of lines) {
    addCandidate(extractClassroomUrlFromLine_(line));
  }

  return candidates;
}

function isClassroomAssignmentUrl_(value) {
  return /\/c\/[^/]+\/a\/[^/]+\/details$/.test(String(value || ''));
}

function removeEmailFooterForUrlExtraction_(body) {
  const text = String(body || '');
  const footerMarker = 'Google LLC 1600 Amphitheatre Parkway';
  const footerIndex = text.indexOf(footerMarker);

  if (footerIndex >= 0) {
    return text.slice(0, footerIndex);
  }

  return text;
}

function getClassroomUrlFromNextLine_(lines, markerText) {
  for (let i = 0; i < lines.length - 1; i++) {
    const currentLine = String(lines[i] || '').trim();

    if (currentLine === markerText || currentLine.includes(markerText)) {
      return extractClassroomUrlFromLine_(lines[i + 1]);
    }
  }

  return '';
}

function extractClassroomUrlFromLine_(line) {
  const text = String(line || '').trim();
  const decodedText = decodeUrlTextForClassroom_(text);

  if (!text.includes('classroom.google.com') && !decodedText.includes('classroom.google.com')) {
    return '';
  }

  const targetText = text.includes('classroom.google.com') ? text : decodedText;
  const angleMatch = targetText.match(/<([^<>]*classroom\.google\.com[^<>]*)>/);

  if (angleMatch) {
    return angleMatch[1].trim();
  }

  const bareMatch = targetText.match(/https?:\/\/[^\s<>]+/);

  if (!bareMatch) {
    return '';
  }

  const url = bareMatch[0]
    .replace(/[、。]+$/g, '')
    .trim();

  if (!url.includes('classroom.google.com')) {
    return '';
  }

  return url;
}

function decodeUrlTextForClassroom_(value) {
  let text = String(value || '');

  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(text);

      if (decoded === text) {
        return decoded;
      }

      text = decoded;
    } catch (error) {
      return text;
    }
  }

  return text;
}

function extractCourseName_(body) {
  const lines = getClassroomMeaningfulLines_(body);

  if (lines.length > 0 && !isClassroomNotificationMarker_(lines[0])) {
    return lines[0];
  }

  const markerIndex = getClassroomNotificationMarkerIndex_(lines);

  if (markerIndex > 0) {
    return lines[markerIndex - 1];
  }

  return '授業名未抽出';
}

function extractTitle_(subject, body) {
  const subjectText = String(subject || '');
  const subjectMatch = subjectText.match(/(?:新しい課題|新しいお知らせ|新しい資料)[:：]\s*[「"]?(.+?)[」"]?$/);

  if (subjectMatch) {
    return subjectMatch[1].trim();
  }

  const lines = getClassroomMeaningfulLines_(body);
  const markerIndex = getClassroomNotificationMarkerIndex_(lines);

  if (markerIndex >= 0) {
    const titleCandidate = lines
      .slice(markerIndex + 1)
      .find(line => {
        if (isClassroomNotificationMarker_(line)) {
          return false;
        }

        if (line.includes('先生が')) {
          return false;
        }

        return !isNoiseLine_(line);
      });

    if (titleCandidate) {
      return titleCandidate;
    }
  }

  for (const line of lines) {
    if (isNoiseLine_(line)) {
      continue;
    }

    if (line.includes('課題を表示') || line.includes('成績を表示')) {
      continue;
    }

    if (TASK_KEYWORDS.some(keyword => line.includes(keyword))) {
      return line;
    }
  }

  return 'タイトル未抽出';
}

function getCleanLines_(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
}

function isNoiseLine_(line) {
  const text = String(line || '').trim();

  if (text === '') {
    return true;
  }

  if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('<http')) {
    return true;
  }

  if (text.includes('accounts.google.com')) {
    return true;
  }

  if (text.includes('Google LLC')) {
    return true;
  }

  if (text.includes('このメールは、Google Classroom')) {
    return true;
  }

  if (text.includes('通知設定')) {
    return true;
  }

  return false;
}

function extractDueDate_(text, receivedDate) {
  const sourceText = String(text || '');
  const monthDayYearResolver = createMonthDayYearResolver_(receivedDate);

  if (
    sourceText.includes('期限なし') ||
    sourceText.includes('締切なし') ||
    sourceText.includes('提出期限なし')
  ) {
    return {
      dueDate: '期限なし',
      dueStatus: '期限なし'
    };
  }

  let result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  if (
    sourceText.includes('明日まで') ||
    sourceText.includes('明日締切') ||
    sourceText.includes('明日提出')
  ) {
    const due = new Date(receivedDate);
    due.setDate(due.getDate() + 1);

    return {
      dueDate: formatDateObject_(due),
      dueStatus: '相対日付抽出'
    };
  }

  const weekdayMatch = sourceText.match(/今週\s*(月曜|火曜|水曜|木曜|金曜|土曜|日曜|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日)まで/);

  if (weekdayMatch) {
    const due = getDateOfThisWeekday_(receivedDate, weekdayMatch[1]);

    return {
      dueDate: formatDateObject_(due),
      dueStatus: '相対日付抽出'
    };
  }

  result = findValidDueDate_(
    sourceText,
    /(?:^|[^\d/])(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?(?!\d|\/)/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:^|[^\d/])(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?(?!\d|\/)/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?(?!\d|\/)/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  return {
    dueDate: '',
    dueStatus: '期限未検出・要確認'
  };
}

function findValidDueDate_(text, regex, status, fixedYear) {
  let match;

  while ((match = regex.exec(text)) !== null) {
    let year;
    let month;
    let day;
    let time;

    if (fixedYear) {
      year = typeof fixedYear === 'function'
        ? fixedYear(match[1], match[2])
        : fixedYear;
      month = match[1];
      day = match[2];
      time = match[3];
    } else {
      year = match[1];
      month = match[2];
      day = match[3];
      time = match[4];
    }

    const result = buildDueDateResult_(year, month, day, time, status);

    if (result) {
      return result;
    }
  }

  return null;
}

function buildDueDateResult_(year, month, day, timeText, status) {
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);

  if (!isValidDateParts_(yearNum, monthNum, dayNum)) {
    return null;
  }

  const time = normalizeTimeText_(timeText);

  return {
    dueDate: formatDueDate_(yearNum, monthNum, dayNum, time),
    dueStatus: status
  };
}

function formatDueDate_(year, month, day, time) {
  const y = String(year);
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');

  if (time) {
    return `${y}/${m}/${d} ${time}`;
  }

  return `${y}/${m}/${d}`;
}

function getYearFromDate_(date) {
  if (date instanceof Date) {
    return date.getFullYear();
  }

  return new Date().getFullYear();
}

function createMonthDayYearResolver_(receivedDate) {
  const base = receivedDate instanceof Date
    ? new Date(receivedDate)
    : new Date();

  base.setHours(0, 0, 0, 0);

  return (month, day) => {
    const baseYear = base.getFullYear();
    const monthNum = Number(month);
    const dayNum = Number(day);

    if (!isValidDateParts_(baseYear, monthNum, dayNum)) {
      return baseYear;
    }

    const candidate = new Date(baseYear, monthNum - 1, dayNum);
    const sixMonthsMs = 183 * 24 * 60 * 60 * 1000;

    if (candidate.getTime() < base.getTime() - sixMonthsMs) {
      return baseYear + 1;
    }

    return baseYear;
  };
}

function formatDateObject_(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  return `${y}/${m}/${d}`;
}

function getDateOfThisWeekday_(baseDate, weekdayText) {
  const weekdayMap = {
    '日曜': 0,
    '日曜日': 0,
    '月曜': 1,
    '月曜日': 1,
    '火曜': 2,
    '火曜日': 2,
    '水曜': 3,
    '水曜日': 3,
    '木曜': 4,
    '木曜日': 4,
    '金曜': 5,
    '金曜日': 5,
    '土曜': 6,
    '土曜日': 6
  };

  const targetDay = weekdayMap[weekdayText];

  if (targetDay === undefined) {
    return new Date(baseDate);
  }

  const base = new Date(baseDate);
  const diff = targetDay - base.getDay();

  base.setDate(base.getDate() + diff);

  return base;
}

function getNotificationsForWeb() {
  const data = mergeNotificationAndInCampusExtractedItemsForWeb_(
    getActiveNotificationItemsForWeb_(),
    getActiveInCampusExtractedItemsForWeb_()
  );

  return data
    .filter(item => !isExpiredNotificationForWeb_(item))
    .filter(item => !isStaleUnknownDueNotificationForWeb_(item))
    .sort((a, b) => b.receivedAtTime - a.receivedAtTime);
}

function getActiveNotificationItemsForWeb_() {
  const ss = getOrCreateSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  const values = sheet.getDataRange().getValues();
  let rows = values.slice(1);

  rows = rows.filter(row => isTaskRelatedRow_(row));
  rows = rows.filter(row => String(row[12] || '') !== '完了');

  const data = rows.map(row => rowToNotificationItem_(row));

  return data;
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

  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function isExpiredNotificationForWeb_(item) {
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

  return deadline.getTime() < Date.now();
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

function getClassroomMainContentText_(body) {
  const lines = getClassroomMeaningfulLines_(body);
  const markerIndex = getClassroomNotificationMarkerIndex_(lines);

  const contentLines = markerIndex >= 0
    ? lines.slice(markerIndex + 1)
    : lines;

  return contentLines
    .filter(line => {
      const text = String(line || '').trim();

      if (text.startsWith('投稿日:')) {
        return false;
      }

      if (text.startsWith('投稿者:')) {
        return false;
      }

      if (text.includes('投稿者:')) {
        return false;
      }

      if (text.includes('先生が')) {
        return false;
      }

      return true;
    })
    .join('\n');
}

function hasAnnouncementTaskKeyword_(body) {
  const mainText = getClassroomMainContentText_(body);

  const hasTaskKeyword = ANNOUNCEMENT_TASK_KEYWORDS.some(keyword => {
    return mainText.includes(keyword);
  });

  if (!hasTaskKeyword) {
    return false;
  }

  return hasAnnouncementActionInstruction_(body);
}

function hasAnnouncementActionInstruction_(body) {
  const mainText = getClassroomMainContentText_(body);

  const actionPatterns = [
    /宿題は以下/,
    /課題は以下/,
    /宿題です/,
    /課題です/,
    /宿題があります/,
    /課題があります/,
    /提出してください/,
    /提出して下さい/,
    /提出すること/,
    /提出するように/,
    /提出しておくこと/,
    /実施してください/,
    /実施すること/,
    /行ってください/,
    /やってください/,
    /取り組んでください/,
    /完成させてください/,
    /書いてください/,
    /作成してください/,
    /次回まで/,
    /来週まで/,
    /授業までに/,
    /期限[:：]/,
    /締切[:：]/,
    /締め切り[:：]/
  ];

  return actionPatterns.some(pattern => pattern.test(mainText));
}

function isClassroomAiWarningAnnouncement_(body) {
  const mainText = getClassroomMainContentText_(body);
  const normalizedText = String(mainText || '').replace(/\s+/g, '');

  const aiWarningKeywords = [
    '生成AI',
    'AIで宿題',
    'AIで課題',
    'AIで解いて',
    '0点',
    '疑われる',
    '対策を始める',
    '直に提出'
  ];

  return aiWarningKeywords.some(keyword => normalizedText.includes(keyword));
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

  if (dueStatus === '提出記録' || status === '完了記録') {
    return false;
  }

  if (source !== 'Google Classroom' && source !== 'inCampus') {
    return false;
  }

  if (source === 'Google Classroom') {
    const notificationType = getClassroomNotificationType_(body);

    if (isClassroomAiWarningAnnouncement_(body)) {
      return false;
    }

    if (notificationType === 'newMaterial') {
      return false;
    }

    if (notificationType === 'privateComment') {
      return false;
    }

    if (notificationType === 'returned') {
      return false;
    }

    if (notificationType === 'newAssignment') {
      return true;
    }

    if (notificationType === 'newAnnouncement') {
      return hasAnnouncementTaskKeyword_(body);
    }

    return false;
  }

  return isInCampusTaskRelated_(subject, body);
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
    const hasTime = hour !== 0 || minute !== 0;

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
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);

  if (!isValidDateParts_(yearNum, monthNum, dayNum)) {
    return {
      dueDate: '期限未検出',
      dueDateKey: '',
      dueTime: '',
      dueType: 'unknown'
    };
  }

  const y = String(yearNum);
  const m = String(monthNum).padStart(2, '0');
  const d = String(dayNum).padStart(2, '0');
  const time = normalizeTimeText_(timeText);

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
  saveClassroomMailsToSheet();
  return getNotificationsForWeb();
}

function clearNotificationSheetData_() {
  const ss = getOrCreateSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return;
  }

  sheet.deleteRows(2, lastRow - 1);
  SpreadsheetApp.flush();
}

function rebuildAndGetNotificationsForWeb() {
  clearNotificationSheetData_();
  SpreadsheetApp.flush();

  saveClassroomMailsToSheet();
  SpreadsheetApp.flush();

  return getNotificationsForWeb();
}

function setupAutoFetchTrigger() {
  const targetFunction = 'saveClassroomMailsToSheet';
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === targetFunction) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(targetFunction)
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log('15分ごとの自動取得トリガーを作成しました。');
}

function deleteAutoFetchTrigger() {
  const targetFunction = 'saveClassroomMailsToSheet';
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === targetFunction) {
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
  const targetMessageId = String(messageId || '');

  if (!targetMessageId) {
    return responseBuilder();
  }

  if (targetMessageId.startsWith('incampus:')) {
    updateInCampusExtractedStatus_(targetMessageId, status);
    return responseBuilder();
  }

  const ss = getOrCreateSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return responseBuilder();
  }

  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const rowMessageId = String(values[i][1] || '');

    if (rowMessageId === targetMessageId) {
      const sheetRow = i + 1;

      sheet.getRange(sheetRow, 13).setValue(status);

      if (status === '完了') {
        sheet.getRange(sheetRow, 14).setValue(new Date());
      } else {
        sheet.getRange(sheetRow, 14).clearContent();
      }

      SpreadsheetApp.flush();

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
    title: row[4] && row[4] !== 'タイトル未抽出' ? row[4] : row[7],

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

function getActiveInCampusExtractedItemsForWeb_() {
  return getInCampusExtractedItemsForWeb_('active');
}

function getCompletedInCampusExtractedItemsForWeb_() {
  return getInCampusExtractedItemsForWeb_('completed');
}

function getInCampusExtractedItemsForWeb_(viewMode) {
  const sheet = getOrCreateInCampusSheet_();

  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  const values = sheet.getDataRange().getValues();
  const headerMap = getInCampusHeaderMap_(sheet);
  const rows = values.slice(1);
  const items = rows
    .map(row => rowToInCampusExtractedItem_(row, headerMap))
    .filter(item => item.messageId);
  const submissionItems = items.filter(item => isInCampusSubmissionItemForWeb_(item));
  const assignmentItems = items.filter(item => !isInCampusSubmissionItemForWeb_(item));

  applyInCampusSubmissionItemsForWeb_(assignmentItems, submissionItems);
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
  const recordTitle = normalizeInCampusMatchText_(record.title);
  const recordCourseName = normalizeInCampusCourseNameForMatch_(record.courseName);

  return assignmentItems.find(item => {
    const itemTitle = normalizeInCampusMatchText_(item.title);
    const itemCourseName = normalizeInCampusCourseNameForMatch_(item.courseName);
    const titleMatches = itemTitle &&
      recordTitle &&
      (itemTitle === recordTitle ||
      itemTitle.includes(recordTitle) ||
      recordTitle.includes(itemTitle));
    const courseMatches = !recordCourseName ||
      !itemCourseName ||
      itemCourseName === recordCourseName ||
      itemCourseName.includes(recordCourseName) ||
      recordCourseName.includes(itemCourseName);

    return titleMatches && courseMatches;
  });
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
    return JSON.parse(String(value));
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
  const data = mergeNotificationAndInCampusExtractedItemsForWeb_(
    getCompletedNotificationItemsForWeb_(),
    getCompletedInCampusExtractedItemsForWeb_()
  );

  return data
    .filter(item => !isExpiredNotificationForWeb_(item))
    .filter(item => !isStaleUnknownDueNotificationForWeb_(item))
    .sort((a, b) => {
      if (a.completedAtTime !== b.completedAtTime) {
        return b.completedAtTime - a.completedAtTime;
      }

      return b.receivedAtTime - a.receivedAtTime;
    });
}

function mergeNotificationAndInCampusExtractedItemsForWeb_(notificationItems, extractedItems) {
  enrichInCampusExtractedItemsFromNotificationItemsForWeb_(notificationItems, extractedItems);

  const filteredNotificationItems = notificationItems.filter(item => {
    if (String(item.source || '') !== 'inCampus') {
      return true;
    }

    return !extractedItems.some(extractedItem => isSameInCampusAssignmentForWeb_(item, extractedItem));
  });

  return filteredNotificationItems.concat(extractedItems);
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
  const titleA = normalizeInCampusMatchText_(a && a.title);
  const titleB = normalizeInCampusMatchText_(b && b.title);

  if (!titleA || !titleB) {
    return false;
  }

  const titleMatches = titleA === titleB ||
    titleA.includes(titleB) ||
    titleB.includes(titleA);

  if (!titleMatches) {
    return false;
  }

  const courseA = normalizeInCampusCourseNameForMatch_(a && a.courseName);
  const courseB = normalizeInCampusCourseNameForMatch_(b && b.courseName);

  return isGenericInCampusCourseNameForMatch_(courseA) ||
    isGenericInCampusCourseNameForMatch_(courseB) ||
    courseA === courseB ||
    courseA.includes(courseB) ||
    courseB.includes(courseA);
}

function isGenericInCampusCourseNameForMatch_(courseName) {
  const text = String(courseName || '');

  return text === '' ||
    text === 'incampus' ||
    text === 'incampusお知らせ';
}

function getCompletedNotificationItemsForWeb_() {
  const ss = getOrCreateSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  const values = sheet.getDataRange().getValues();
  let rows = values.slice(1);

  rows = rows.filter(row => isTaskRelatedRow_(row));
  rows = rows.filter(row => String(row[12] || '') === '完了');

  const data = rows.map(row => rowToNotificationItem_(row));

  return data;
}

function debugNotificationSheet() {
  const ss = getOrCreateSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  Logger.log('スプレッドシートURL: ' + ss.getUrl());
  Logger.log('シート名: ' + CONFIG.SHEET_NAME);

  if (!sheet) {
    Logger.log('通知一覧シートが見つかりません');
    return;
  }

  Logger.log('実際に読んでいるシート名: ' + sheet.getName());
  Logger.log('実際に読んでいるシートID: ' + sheet.getSheetId());
  Logger.log('lastRow: ' + sheet.getLastRow());
  Logger.log('lastColumn: ' + sheet.getLastColumn());

  if (sheet.getLastRow() >= 2) {
    const values = sheet.getDataRange().getValues();
    const rows = values.slice(1);

    Logger.log('データ行数: ' + rows.length);
    Logger.log('1件目の通知元: ' + rows[0][2]);
    Logger.log('1件目の授業名: ' + rows[0][3]);
    Logger.log('1件目のタイトル: ' + rows[0][4]);
    Logger.log('1件目の期限: ' + rows[0][5]);
    Logger.log('1件目の期限状態: ' + rows[0][6]);
    Logger.log('1件目の件名: ' + rows[0][7]);
  }
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

  Logger.log('再構築が完了しました。表示対象件数: ' + data.length);
}

const INCAMPUS_SHEET_NAME = 'inCampus抽出';
const INCAMPUS_SUBMISSION_RECORD_TYPE = 'submissionRecord';
const INCAMPUS_SUBMISSION_RECORD_STATUS = '完了記録';

// 配布時は空文字のままにし、Webアプリは「アクセスしているユーザーとして実行」でデプロイする。
// Webアプリを「自分として実行」で共有すると、保存先とUserPropertiesは所有者側に集約される。
// 管理者が単一シートへ集約したい場合だけ、明示的にIDを入れる。
const DEFAULT_SPREADSHEET_ID = '';
const USER_SPREADSHEET_ID_PROPERTY = 'TASKHUB_SPREADSHEET_ID';
const LEGACY_SPREADSHEET_ID_PROPERTY = 'SPREADSHEET_ID';
const API_TOKEN_PROPERTY = 'TASKHUB_API_TOKEN';
const API_TOKEN_MIN_LENGTH = 48;
const MAX_POST_BODY_LENGTH = 200000;
const MAX_POST_RECORDS = 100;
const ALLOWED_INCAMPUS_HOST = 'ic.ss.senshu-u.ac.jp';

const ASSIGNMENT_FIELD_LIMITS = {
  source: 32,
  type: 64,
  title: 500,
  body: 5000,
  startAt: 64,
  dueAt: 64,
  periodText: 1200,
  lateSubmission: 120,
  assignmentType: 120,
  attachment: 1200,
  pageUrl: 2048,
  assignmentKey: 512,
  extractedAt: 64,
  receivedAt: 64,
  rawText: 5000,
  courseName: 500,
  updateText: 2000,
  updateAction: 128,
  updateAt: 64,
  status: 32,
  completedAt: 64
};

const CLASSROOM_RECORD_FIELD_LIMITS = {
  title: 500,
  courseName: 500,
  classroomUrl: 2048,
  pageUrl: 2048,
  completedAt: 64,
  courseId: 128,
  streamItemId: 128,
  dueText: 500,
  dueDate: 64,
  dueTime: 16,
  dueAt: 64
};

const INCAMPUS_HEADERS = [
  'source',
  'type',
  'title',
  'body',
  'startAt',
  'dueAt',
  'periodText',
  'lateSubmission',
  'assignmentType',
  'attachment',
  'pageUrl',
  'extractedAt',
  'receivedAt',
  'rawJson',
  'status',
  'completedAt',
  'assignmentKey'
];

function doPost(e) {
  const lock = LockService.getUserLock();
  let hasLock = false;

  try {
    if (!lock.tryLock(5000)) {
      throw new Error('処理が混み合っています。少し待ってから再実行してください。');
    }

    hasLock = true;

    const payload = parseJsonBody_(e);
    assertValidApiToken_(payload);

    if (payload.action === 'upsertInCampusAssignment') {
      const assignment = sanitizeObjectByFieldLimits_(payload.assignment || {}, ASSIGNMENT_FIELD_LIMITS);
      validateAssignment_(assignment);

      const result = upsertInCampusAssignment_(assignment);

      return jsonResponse_({
        ok: true,
        updated: result.updated,
        row: result.row
      });
    }

    if (payload.action === 'completeClassroomAssignments') {
      const result = completeClassroomAssignments_(sanitizePostRecords_(payload.records || []));

      return jsonResponse_({
        ok: true,
        foundCount: result.foundCount,
        matchedCount: result.matchedCount,
        createdCount: result.createdCount,
        unmatchedCount: result.unmatchedCount,
        results: result.results
      });
    }

    if (payload.action === 'updateClassroomDueTimes') {
      const result = updateClassroomDueTimes_(sanitizePostRecords_(payload.records || []));

      return jsonResponse_({
        ok: true,
        foundCount: result.foundCount,
        matchedCount: result.matchedCount,
        createdCount: result.createdCount,
        unmatchedCount: result.unmatchedCount,
        dueTimeCount: result.dueTimeCount,
        results: result.results
      });
    }

    throw new Error('未対応のactionです: ' + payload.action);
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  } finally {
    if (hasLock) {
      lock.releaseLock();
    }
  }
}

function parseJsonBody_(e) {
  const body = e && e.postData && e.postData.contents;

  if (!body) {
    throw new Error('POST本文が空です。');
  }

  if (String(body).length > MAX_POST_BODY_LENGTH) {
    throw new Error('POST本文が大きすぎます。');
  }

  return JSON.parse(body);
}

function getSecuritySettingsForWeb() {
  const apiToken = getSavedApiToken_();
  const hasApiToken = isValidApiToken_(apiToken);

  return {
    postAuthRequired: true,
    hasApiToken,
    tokenPreview: hasApiToken ? maskApiToken_(apiToken) : '未発行'
  };
}

function rotateApiTokenForWeb() {
  const apiToken = generateApiToken_();
  PropertiesService.getUserProperties().setProperty(API_TOKEN_PROPERTY, apiToken);

  return {
    postAuthRequired: true,
    hasApiToken: true,
    apiToken,
    tokenPreview: maskApiToken_(apiToken),
    tokenReturnedOnce: true
  };
}

function assertValidApiToken_(payload) {
  const expectedToken = getSavedApiToken_();
  const providedToken = getProvidedApiToken_(payload);

  if (!isValidApiToken_(expectedToken)) {
    throw new Error('APIトークンが未発行です。セキュリティ設定でトークンを再発行し、拡張機能へ設定してください。');
  }

  if (!providedToken || !constantTimeEquals_(providedToken, expectedToken)) {
    throw new Error('認証に失敗しました。セキュリティ設定のAPIトークンを送信してください。');
  }
}

function getProvidedApiToken_(payload) {
  return String(
    payload.apiToken ||
    payload.securityToken ||
    payload.token ||
    ''
  ).trim();
}

function getSavedApiToken_() {
  const props = PropertiesService.getUserProperties();

  return String(props.getProperty(API_TOKEN_PROPERTY) || '').trim();
}

function generateApiToken_() {
  return [
    Utilities.getUuid(),
    Utilities.getUuid()
  ].join('').replace(/-/g, '');
}

function isValidApiToken_(token) {
  return /^[A-Za-z0-9_-]+$/.test(String(token || '')) &&
    String(token || '').length >= API_TOKEN_MIN_LENGTH;
}

function maskApiToken_(token) {
  const text = String(token || '');

  if (text.length <= 12) {
    return '未設定';
  }

  return `${text.slice(0, 6)}...${text.slice(-6)}`;
}

function constantTimeEquals_(left, right) {
  const leftText = String(left || '');
  const rightText = String(right || '');
  const maxLength = Math.max(leftText.length, rightText.length);
  let diff = leftText.length === rightText.length ? 0 : 1;

  for (let i = 0; i < maxLength; i++) {
    const leftCode = i < leftText.length ? leftText.charCodeAt(i) : 0;
    const rightCode = i < rightText.length ? rightText.charCodeAt(i) : 0;
    diff |= leftCode ^ rightCode;
  }

  return diff === 0;
}

function sanitizePostRecords_(records) {
  if (!Array.isArray(records)) {
    throw new Error('recordsが配列ではありません。');
  }

  if (records.length > MAX_POST_RECORDS) {
    throw new Error('一度に送信できるrecordsが多すぎます。');
  }

  return records.map(record => sanitizeObjectByFieldLimits_(record || {}, CLASSROOM_RECORD_FIELD_LIMITS));
}

function sanitizeObjectByFieldLimits_(source, fieldLimits) {
  const sanitized = {};

  Object.keys(fieldLimits).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      return;
    }

    sanitized[key] = limitText_(source[key], fieldLimits[key]);
  });

  return sanitized;
}

function limitText_(value, maxLength) {
  if (value instanceof Date) {
    return value;
  }

  const text = typeof value === 'object' && value !== null
    ? JSON.stringify(value)
    : String(value || '');

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength);
}

function toSafeSpreadsheetRow_(rowValues) {
  return rowValues.map(value => toSafeSpreadsheetCell_(value));
}

function toSafeSpreadsheetCell_(value) {
  if (value instanceof Date || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);

  if (/^[\t\r\n ]*[=+\-@]/.test(text)) {
    return "'" + text;
  }

  return text;
}

function isAllowedInCampusUrlForStorage_(value) {
  const hostPattern = ALLOWED_INCAMPUS_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    '^https://' + hostPattern + '(?::443)?(?:[/?#]|$)[^\\s<>"\'\\\\]*$',
    'i'
  );

  return pattern.test(String(value || '').trim());
}

function validateAssignment_(assignment) {
  if (assignment.source !== 'inCampus') {
    throw new Error('sourceがinCampusではありません。');
  }

  if (!assignment.title && !assignment.body && !assignment.periodText) {
    throw new Error('課題情報が空です。');
  }

  if (!assignment.pageUrl) {
    throw new Error('pageUrlがありません。');
  }

  if (!isAllowedInCampusUrlForStorage_(assignment.pageUrl)) {
    throw new Error('pageUrlはinCampusのHTTPS URLだけ保存できます。');
  }
}

function upsertInCampusAssignment_(assignment) {
  const sheet = getOrCreateInCampusSheet_();
  const submissionRecord = extractInCampusSubmissionRecordFromAssignment_(assignment);

  if (submissionRecord) {
    return upsertInCampusSubmissionRecord_(sheet, assignment, submissionRecord);
  }

  const existingRowNumber = findExistingInCampusAssignmentRow_(sheet, assignment);

  if (existingRowNumber) {
    const existingRow = sheet.getRange(existingRowNumber, 1, 1, INCAMPUS_HEADERS.length).getValues()[0];
    const rowValues = buildAssignmentRow_(assignment, existingRow);
    sheet.getRange(existingRowNumber, 1, 1, INCAMPUS_HEADERS.length).setValues([rowValues]);
    applySavedInCampusExtractedSubmissionRecords_(sheet);
    return { updated: true, row: existingRowNumber };
  }

  const rowValues = buildAssignmentRow_(assignment);
  sheet.appendRow(rowValues);
  applySavedInCampusExtractedSubmissionRecords_(sheet);
  return { updated: false, row: sheet.getLastRow() };
}

function extractInCampusSubmissionRecordFromAssignment_(assignment) {
  const text = [
    assignment.title,
    assignment.body,
    assignment.periodText,
    assignment.rawText
  ].filter(Boolean).join('\n');
  const records = extractInCampusSubmissionRecords_('', text);

  if (records.length === 0) {
    return null;
  }

  const record = records[0];

  return {
    courseName: record.courseName || assignment.courseName || '',
    title: record.title,
    submittedAt: record.submittedAt || assignment.receivedAt || assignment.extractedAt || '',
    pageUrl: assignment.pageUrl || ''
  };
}

function upsertInCampusSubmissionRecord_(sheet, assignment, record) {
  const markerAssignment = Object.assign({}, assignment, {
    type: INCAMPUS_SUBMISSION_RECORD_TYPE,
    title: record.title,
    body: assignment.body || assignment.title || '',
    pageUrl: buildInCampusSubmissionRecordPageUrl_(assignment, record),
    assignmentKey: buildInCampusSubmissionRecordAssignmentKey_(assignment, record),
    status: INCAMPUS_SUBMISSION_RECORD_STATUS,
    completedAt: record.submittedAt || assignment.receivedAt || assignment.extractedAt || ''
  });
  const existingRowNumber = findExistingInCampusAssignmentRow_(sheet, markerAssignment);

  if (existingRowNumber) {
    const existingRow = sheet.getRange(existingRowNumber, 1, 1, INCAMPUS_HEADERS.length).getValues()[0];
    const rowValues = buildAssignmentRow_(markerAssignment, existingRow);
    sheet.getRange(existingRowNumber, 1, 1, INCAMPUS_HEADERS.length).setValues([rowValues]);
    applySavedInCampusExtractedSubmissionRecords_(sheet);
    return { updated: true, row: existingRowNumber };
  }

  const rowValues = buildAssignmentRow_(markerAssignment);
  sheet.appendRow(rowValues);
  applySavedInCampusExtractedSubmissionRecords_(sheet);
  return { updated: false, row: sheet.getLastRow() };
}

function buildInCampusSubmissionRecordPageUrl_(assignment, record) {
  const baseUrl = assignment.pageUrl || 'incampus-submission';
  const key = [
    record.title,
    record.submittedAt,
    assignment.extractedAt,
    assignment.receivedAt
  ].filter(Boolean).join('-');

  return `${baseUrl}#submitted-${encodeURIComponent(normalizeInCampusMatchText_(key))}`;
}

function buildInCampusSubmissionRecordAssignmentKey_(assignment, record) {
  const existingKey = String(assignment.assignmentKey || '').trim();

  if (assignment.type === INCAMPUS_SUBMISSION_RECORD_TYPE && existingKey) {
    return existingKey;
  }

  const parts = [
    'inCampus',
    'submission',
    existingKey || assignment.pageUrl || '',
    record.title || assignment.title || '',
    record.submittedAt || assignment.receivedAt || assignment.extractedAt || ''
  ].filter(Boolean);

  return parts.length > 2 ? parts.join(':') : '';
}

function findExistingInCampusAssignmentRow_(sheet, assignment) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return 0;
  }

  const headerMap = getInCampusHeaderMap_(sheet);
  const rowCount = lastRow - 1;
  const assignmentKey = String(assignment.assignmentKey || '').trim();
  const pageUrl = String(assignment.pageUrl || '').trim();
  const findByColumn = (column, expectedValue, transform) => {
    if (!column || !expectedValue) {
      return 0;
    }

    const values = sheet.getRange(2, column, rowCount, 1).getValues();
    const index = values.findIndex(row => transform(row[0]) === expectedValue);

    return index === -1 ? 0 : index + 2;
  };

  if (assignmentKey) {
    const rowByAssignmentKey = findByColumn(
      headerMap.assignmentKey,
      assignmentKey,
      value => String(value || '').trim()
    );

    if (rowByAssignmentKey) {
      return rowByAssignmentKey;
    }

    const rowByRawJsonAssignmentKey = findByColumn(
      headerMap.rawJson,
      assignmentKey,
      value => String(parseInCampusRawJson_(value).assignmentKey || '').trim()
    );

    if (rowByRawJsonAssignmentKey) {
      return rowByRawJsonAssignmentKey;
    }
  }

  return findByColumn(
    headerMap.pageUrl,
    pageUrl,
    value => String(value || '').trim()
  );
}

function applySavedInCampusExtractedSubmissionRecords_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) {
    return 0;
  }

  const values = sheet.getDataRange().getValues();
  let completedCount = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const type = String(row[1] || '');
    const status = String(row[14] || '');

    if (type !== INCAMPUS_SUBMISSION_RECORD_TYPE && status !== INCAMPUS_SUBMISSION_RECORD_STATUS) {
      continue;
    }

    const raw = parseInCampusRawJson_(row[13]);
    const record = extractInCampusSubmissionRecordFromAssignment_(raw) || {
      courseName: raw.courseName || '',
      title: row[2],
      submittedAt: row[15] || row[12] || row[11] || '',
      pageUrl: raw.pageUrl || ''
    };

    if (completeMatchingInCampusExtractedRow_(sheet, record)) {
      completedCount++;
    }
  }

  return completedCount;
}

function completeMatchingInCampusExtractedRow_(sheet, record) {
  if (!record || !record.title || !sheet || sheet.getLastRow() < 2) {
    return false;
  }

  const values = sheet.getDataRange().getValues();
  const recordTitle = normalizeInCampusMatchText_(record.title);
  const recordCourseName = normalizeInCampusCourseNameForMatch_(record.courseName);
  const recordPageUrl = String(record.pageUrl || '');

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const type = String(row[1] || '');
    const status = String(row[14] || '');

    if (type === INCAMPUS_SUBMISSION_RECORD_TYPE || status === '完了') {
      continue;
    }

    const raw = parseInCampusRawJson_(row[13]);
    const rowTitle = normalizeInCampusMatchText_(row[2] || raw.title);
    const rowCourseName = normalizeInCampusCourseNameForMatch_(raw.courseName);
    const rowPageUrl = String(row[10] || '');
    const titleMatches = rowTitle &&
      recordTitle &&
      (rowTitle === recordTitle ||
      rowTitle.includes(recordTitle) ||
      recordTitle.includes(rowTitle));
    const courseMatches = !recordCourseName ||
      !rowCourseName ||
      rowCourseName === recordCourseName ||
      rowCourseName.includes(recordCourseName) ||
      recordCourseName.includes(rowCourseName);
    const pageUrlMatches = recordPageUrl &&
      rowPageUrl &&
      (rowPageUrl === recordPageUrl ||
      rowPageUrl.startsWith(recordPageUrl) ||
      recordPageUrl.startsWith(rowPageUrl));

    if (!titleMatches && !pageUrlMatches) {
      continue;
    }

    if (!pageUrlMatches && !courseMatches) {
      continue;
    }

    const rowNumber = i + 1;
    sheet.getRange(rowNumber, 15).setValue('完了');
    sheet.getRange(rowNumber, 16).setValue(toSafeSpreadsheetCell_(record.submittedAt || new Date()));
    SpreadsheetApp.flush();

    return true;
  }

  return false;
}

function getOrCreateInCampusSheet_() {
  const ss = getTargetSpreadsheet_();
  let sheet = ss.getSheetByName(INCAMPUS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(INCAMPUS_SHEET_NAME);
  }

  setupInCampusHeader_(sheet);
  return sheet;
}

function getTargetSpreadsheet_() {
  return getOrCreateSpreadsheet_();
}

function setupInCampusHeader_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), INCAMPUS_HEADERS.length);
  const range = sheet.getRange(1, 1, 1, lastColumn);
  const current = range.getValues()[0];
  const hasExistingHeader = current.some(value => String(value || '').trim() !== '');

  if (!hasExistingHeader) {
    sheet.getRange(1, 1, 1, INCAMPUS_HEADERS.length).setValues([INCAMPUS_HEADERS]);
    sheet.getRange(1, 1, 1, INCAMPUS_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return;
  }

  const existingHeaders = new Set(current.map(value => String(value || '').trim()).filter(Boolean));
  const requiredHeaders = ['status', 'completedAt', 'assignmentKey'];

  requiredHeaders.forEach(header => {
    if (existingHeaders.has(header)) {
      return;
    }

    const nextColumn = sheet.getLastColumn() + 1;
    sheet.getRange(1, nextColumn).setValue(header).setFontWeight('bold');
    existingHeaders.add(header);
  });

  if (sheet.getFrozenRows() < 1) {
    sheet.setFrozenRows(1);
  }
}

function buildAssignmentRow_(assignment, existingRow) {
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  const existingStatus = existingRow ? String(existingRow[14] || '') : '';
  const existingCompletedAt = existingRow ? existingRow[15] : '';
  const status = existingStatus || assignment.status || '未確認';
  const completedAt = status === '完了'
    ? existingCompletedAt || assignment.completedAt || now
    : '';

  return toSafeSpreadsheetRow_([
    assignment.source || 'inCampus',
    assignment.type || 'assignment',
    assignment.title || '',
    assignment.body || '',
    assignment.startAt || '',
    assignment.dueAt || '',
    assignment.periodText || '',
    assignment.lateSubmission || '',
    assignment.assignmentType || '',
    assignment.attachment || '',
    assignment.pageUrl || '',
    assignment.extractedAt || '',
    now,
    JSON.stringify(assignment),
    status,
    completedAt,
    limitText_(assignment.assignmentKey || '', ASSIGNMENT_FIELD_LIMITS.assignmentKey)
  ]);
}

function completeClassroomAssignments_(records) {
  if (!Array.isArray(records)) {
    throw new Error('recordsが配列ではありません。');
  }

  const ss = getOrCreateSpreadsheet_();
  const sheet = getOrCreateSheet_(ss);
  setupHeader_(sheet);

  if (records.length === 0) {
    return {
      foundCount: records.length,
      matchedCount: 0,
      unmatchedCount: records.length,
      results: records.map(record => buildClassroomCompletionResult_(record, false, '通知一覧に対象行がありません。'))
    };
  }

  const values = sheet.getDataRange().getValues();
  const results = [];
  let matchedCount = 0;
  let createdCount = 0;

  records.forEach(record => {
    const result = completeMatchingClassroomNotificationRow_(sheet, values, record);
    results.push(result);

    if (result.matched) {
      matchedCount++;
    }

    if (result.created) {
      createdCount++;
    }
  });

  SpreadsheetApp.flush();

  return {
    foundCount: records.length,
    matchedCount,
    createdCount,
    unmatchedCount: records.length - matchedCount,
    results
  };
}

function updateClassroomDueTimes_(records) {
  if (!Array.isArray(records)) {
    throw new Error('recordsが配列ではありません。');
  }

  const ss = getOrCreateSpreadsheet_();
  const sheet = getOrCreateSheet_(ss);
  setupHeader_(sheet);

  if (records.length === 0) {
    return {
      foundCount: records.length,
      matchedCount: 0,
      unmatchedCount: records.length,
      dueTimeCount: records.filter(record => record && record.dueTime).length,
      results: records.map(record => buildClassroomDueTimeResult_(record, false, '通知一覧に対象行がありません。'))
    };
  }

  const values = sheet.getDataRange().getValues();
  const results = [];
  let matchedCount = 0;
  let createdCount = 0;

  records.forEach(record => {
    const result = updateMatchingClassroomDueTimeRow_(sheet, values, record);
    results.push(result);

    if (result.matched) {
      matchedCount++;
    }

    if (result.created) {
      createdCount++;
    }
  });

  SpreadsheetApp.flush();

  return {
    foundCount: records.length,
    matchedCount,
    createdCount,
    unmatchedCount: records.length - matchedCount,
    dueTimeCount: records.filter(record => record && record.dueTime).length,
    results
  };
}

function updateMatchingClassroomDueTimeRow_(sheet, values, record) {
  const match = findMatchingClassroomNotificationRow_(values, record, {
    allowTextFallback: false
  });

  if (!match) {
    return buildClassroomDueTimeResult_(record, false, '通知一覧に一致するClassroom課題がないため更新しませんでした。');
  }

  const rowIndex = match.index;
  const rowNumber = rowIndex + 1;
  const dueValue = buildClassroomDueDateValue_(record, values[rowIndex][5]);

  if (!dueValue) {
    return buildClassroomDueTimeResult_(record, false, '更新できる期限情報がありません。');
  }

  sheet.getRange(rowNumber, 6).setValue(toSafeSpreadsheetCell_(dueValue));
  sheet.getRange(rowNumber, 7).setValue('Classroomで時刻補正');
  values[rowIndex][5] = dueValue;
  values[rowIndex][6] = 'Classroomで時刻補正';

  return buildClassroomDueTimeResult_(record, true, '', rowNumber, dueValue);
}

function buildClassroomSyntheticMessageId_(record) {
  const ids = getClassroomRecordIds_(record);

  if (ids.coursePathId && ids.itemPathId) {
    return `classroom:${ids.coursePathId}:${ids.itemPathId}`;
  }

  const classroomUrl = normalizeClassroomUrlForMatch_(record.classroomUrl || record.pageUrl);

  if (classroomUrl) {
    return `classroom:${classroomUrl}`;
  }

  return [
    'classroom',
    normalizeInCampusMatchText_(record.courseName),
    normalizeInCampusMatchText_(record.title)
  ].filter(Boolean).join(':');
}

function findMatchingClassroomNotificationRow_(values, record, options) {
  const allowTextFallback = !(options && options.allowTextFallback === false);
  const recordUrl = normalizeClassroomUrlForMatch_(record.classroomUrl || record.pageUrl);
  const recordIds = getClassroomRecordIds_(record);
  const recordTitle = normalizeInCampusMatchText_(record.title);
  const recordCourseName = normalizeClassroomCourseNameForMatch_(record.courseName);
  const recordSyntheticMessageId = buildClassroomSyntheticMessageId_(record);

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const source = String(row[2] || '');

    if (source !== 'Google Classroom') {
      continue;
    }

    if (isClassroomExtensionSyncRow_(row)) {
      continue;
    }

    const rowBody = String(row[11] || '');
    const rowUrl = normalizeClassroomUrlForMatch_(extractClassroomUrl_(source, rowBody));
    const rowIds = getClassroomRowIds_(row, rowUrl);
    const rowTitle = normalizeInCampusMatchText_(row[4] || row[7]);
    const rowCourseName = normalizeClassroomCourseNameForMatch_(row[3]);
    const syntheticMessageIdMatches = recordSyntheticMessageId &&
      recordSyntheticMessageId === String(row[1] || '').trim();
    const urlMatches = recordUrl && rowUrl && recordUrl === rowUrl;
    const pathIdMatches = recordIds.coursePathId &&
      recordIds.itemPathId &&
      recordIds.coursePathId === rowIds.coursePathId &&
      recordIds.itemPathId === rowIds.itemPathId;
    const exactTitleMatches = recordTitle &&
      rowTitle &&
      recordTitle === rowTitle;
    const exactCourseMatches = recordCourseName &&
      rowCourseName &&
      recordCourseName === rowCourseName;
    const titleMatches = recordTitle &&
      rowTitle &&
      (recordTitle === rowTitle ||
      rowTitle.includes(recordTitle) ||
      recordTitle.includes(rowTitle));
    const relatedCourseMatches = recordCourseName &&
      rowCourseName &&
      (recordCourseName === rowCourseName ||
      rowCourseName.includes(recordCourseName) ||
      recordCourseName.includes(rowCourseName));

    if (
      syntheticMessageIdMatches ||
      urlMatches ||
      pathIdMatches ||
      (allowTextFallback && exactTitleMatches && exactCourseMatches) ||
      (allowTextFallback && titleMatches && relatedCourseMatches)
    ) {
      return {
        index: i,
        row
      };
    }
  }

  return null;
}

function normalizeClassroomCourseNameForMatch_(value) {
  return normalizeInCampusMatchText_(value)
    .replace(/20\d{2}[_-]?(?:前|後|通年|春|夏|秋|冬)?[_-]?(?:月|火|水|木|金|土|日)?\d*$/g, '');
}

function getClassroomRecordIds_(record) {
  const urlIds = extractClassroomPathIds_(record && (record.classroomUrl || record.pageUrl));

  return {
    coursePathId: urlIds.coursePathId || String(record && record.courseId || '').trim(),
    itemPathId: urlIds.itemPathId || String(record && record.streamItemId || '').trim()
  };
}

function getClassroomRowIds_(row, rowUrl) {
  const urlIds = extractClassroomPathIds_(rowUrl);
  const bodyIds = extractClassroomIdsFromText_(row && row[11]);

  return {
    coursePathId: urlIds.coursePathId || bodyIds.coursePathId,
    itemPathId: urlIds.itemPathId || bodyIds.itemPathId
  };
}

function extractClassroomIdsFromText_(text) {
  const value = String(text || '');
  const courseMatch = value.match(/(?:courseId|course-id|data-course-id)\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  const itemMatch = value.match(/(?:streamItemId|stream-item-id|data-stream-item-id)\s*[:=]\s*([A-Za-z0-9_-]+)/i);

  return {
    coursePathId: courseMatch ? courseMatch[1] : '',
    itemPathId: itemMatch ? itemMatch[1] : ''
  };
}

function buildClassroomDueDateValue_(record, existingDueValue) {
  const dueTime = normalizeTimeText_(record.dueTime);
  const existingDueInfo = normalizeDueInfoForWeb_(existingDueValue, '');

  if (existingDueInfo.dueDateKey && dueTime) {
    const parts = existingDueInfo.dueDateKey.split('-');
    return buildDateWithTime_(parts[0], parts[1], parts[2], dueTime);
  }

  const dueAtDate = parseClassroomDate_(record.dueAt);
  if (dueAtDate) {
    return dueAtDate;
  }

  const dueDateText = String(record.dueDate || '').trim();

  if (dueDateText && dueTime) {
    const match = dueDateText.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (match) {
      return buildDateWithTime_(match[1], match[2], match[3], dueTime);
    }
  }

  if (record.dueText) {
    return String(record.dueText);
  }

  return '';
}

function parseClassroomDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  if (!value) {
    return null;
  }

  const date = new Date(value);

  return isNaN(date.getTime()) ? null : date;
}

function buildDateWithTime_(year, month, day, timeText) {
  const time = normalizeTimeText_(timeText);
  const parts = time.split(':');

  if (parts.length !== 2) {
    return '';
  }

  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(parts[0]), Number(parts[1]), 0);

  return isNaN(date.getTime()) ? '' : date;
}

function buildClassroomDueTimeResult_(record, matched, reason, row, dueValue, created) {
  return {
    matched: Boolean(matched),
    created: Boolean(created),
    row: row || '',
    reason: reason || '',
    title: record && record.title || '',
    courseName: record && record.courseName || '',
    classroomUrl: record && (record.classroomUrl || record.pageUrl) || '',
    courseId: record && record.courseId || '',
    streamItemId: record && record.streamItemId || '',
    dueText: record && record.dueText || '',
    dueDate: record && record.dueDate || '',
    dueTime: record && record.dueTime || '',
    savedDueValue: dueValue ? formatDateForDebug_(dueValue) : ''
  };
}

function formatDateForDebug_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  }

  return String(value || '');
}

function completeMatchingClassroomNotificationRow_(sheet, values, record) {
  const match = findMatchingClassroomNotificationRow_(values, record, {
    allowTextFallback: false
  });

  if (!match) {
    return buildClassroomCompletionResult_(record, false, '通知一覧に一致するClassroom課題がないため完了にしませんでした。');
  }

  const sheetRow = match.index + 1;

  sheet.getRange(sheetRow, 13).setValue('完了');
  values[match.index][12] = '完了';

  return buildClassroomCompletionResult_(record, true, '', sheetRow);
}

function buildClassroomCompletionResult_(record, matched, reason, row, created) {
  return {
    matched: Boolean(matched),
    created: Boolean(created),
    row: row || '',
    reason: reason || '',
    title: record && record.title || '',
    courseName: record && record.courseName || '',
    classroomUrl: record && (record.classroomUrl || record.pageUrl) || '',
    courseId: record && record.courseId || '',
    streamItemId: record && record.streamItemId || ''
  };
}

function normalizeClassroomUrlForMatch_(value) {
  let text = String(value || '').trim();

  if (!text) {
    return '';
  }

  text = text.replace(/&amp;/g, '&').replace(/^<|>$/g, '');

  for (let i = 0; i < 3; i++) {
    const continueMatch = text.match(/[?&]continue=([^&\s<>]+)/);

    if (!continueMatch || !continueMatch[1]) {
      break;
    }

    text = decodeUrlTextForClassroom_(continueMatch[1]);
  }

  if (!text.includes('classroom.google.com') && text.includes('%')) {
    text = decodeUrlTextForClassroom_(text);
  }

  const classroomMatch = text.match(/(?:https?:\/\/classroom\.google\.com|\/c\/)[^\s<>"']*/);

  if (!classroomMatch) {
    return '';
  }

  text = classroomMatch[0]
    .replace(/[、。]+$/g, '')
    .trim();

  if (text.startsWith('/')) {
    text = 'https://classroom.google.com' + text;
  }

  const urlMatch = text.match(/^https?:\/\/classroom\.google\.com([^?#]*)/);

  if (!urlMatch || !urlMatch[1]) {
    return '';
  }

  const normalizedPath = urlMatch[1].replace(/\/+$/, '');
  const pathMatch = normalizedPath.match(/\/c\/([^/]+)\/(?:a|m)\/([^/]+)(?:\/details)?$/);

  if (pathMatch) {
    return `https://classroom.google.com/c/${pathMatch[1]}/a/${pathMatch[2]}/details`;
  }

  return `https://classroom.google.com${normalizedPath}`;
}

function extractClassroomPathIds_(classroomUrl) {
  const normalizedUrl = normalizeClassroomUrlForMatch_(classroomUrl);
  const match = normalizedUrl.match(/\/c\/([^/]+)\/(?:a|m)\/([^/]+)(?:\/details)?$/);

  if (!match) {
    return {
      coursePathId: '',
      itemPathId: ''
    };
  }

  return {
    coursePathId: match[1],
    itemPathId: match[2]
  };
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

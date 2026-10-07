// Version this value whenever a parsing or display-preparation rule changes.
// The next Gmail sync then reprocesses old rows from their retained message body.
const NOTICE_PREPROCESSING_VERSION = '2026-10-06-v1';
const NOTICE_PREPROCESSING_LEDGER_KEY = '__taskhubNoticeProcessing';

function stripInCampusFooterForStorage_(body) {
  const text = String(body || '');
  const footer = /(?:^|\r?\n)[\t \u3000]*以上[\t \u3000]*(?:\r?\n[\t \u3000]*)+={3,}[\t \u3000]*(?:\r?\n[\t \u3000]*)+※※このメールは専修大学のin Campus発信専用です。返信はできません。※※[\t \u3000]*(?:\r?\n[\t \u3000]*)*$/;
  return text.replace(footer, '').replace(/[\t \u3000\r\n]+$/, '');
}

function getNotificationProcessedData_(row) {
  if (!Array.isArray(row) || row.__taskhubDisableProcessedMetadata) return null;
  const logicalRecord = row.__taskhubProcessedRecord;
  if (logicalRecord && logicalRecord.version === NOTICE_PREPROCESSING_VERSION) return logicalRecord;
  const column = getNotificationProcessingColumn_(row[2]);
  const data = parseInCampusRawJson_(row[column])[NOTICE_PREPROCESSING_LEDGER_KEY];
  return data && data.version === NOTICE_PREPROCESSING_VERSION ? data : null;
}

function setNotificationProcessedData_(row, data) {
  const column = getNotificationProcessingColumn_(row[2]);
  while (row.length <= column) row.push('');
  const ledger = parseInCampusRawJson_(row[column]);
  ledger[NOTICE_PREPROCESSING_LEDGER_KEY] = data;
  row[column] = JSON.stringify(ledger);
  return row;
}

function preprocessNotificationRowForStorage_(inputRow) {
  const row = Array.isArray(inputRow) ? inputRow.slice() : normalizeNotificationRowWidth_(inputRow);
  if (!row[1] || (row[2] !== 'inCampus' && row[2] !== 'Google Classroom') || isClassroomApiManagedRow_(row)) return row;

  const column = getNotificationProcessingColumn_(row[2]);
  while (row.length <= column) row.push('');
  const existing = parseInCampusRawJson_(row[column])[NOTICE_PREPROCESSING_LEDGER_KEY];
  if (existing && existing.version === NOTICE_PREPROCESSING_VERSION) return row;

  if (row[2] === 'inCampus') {
    row[11] = stripInCampusFooterForStorage_(row[11]);
  }
  const body = String(row[11] || '');
  const receivedAt = parseNotificationReceivedDate_(row[9]);
  let data;

  if (row[2] === 'inCampus') {
    const logicalRecords = extractInCampusMailRecords_(row[7], body, row[9]);
    const records = logicalRecords.map(record => buildInCampusProcessedRecord_(row, record));
    if (records.length) {
      data = {
        version: NOTICE_PREPROCESSING_VERSION,
        source: row[2],
        category: 'multiple-updates',
        isUniversityNotice: false,
        taskRelated: false,
        displayTitle: extractInCampusTitle_(row[7], body),
        displayBody: cleanBodyForWeb_(body, row[2]),
        expiresAt: null,
        records
      };
    } else {
      data = buildSingleNotificationProcessedRecord_(row, 'inCampus', 'general');
    }
  } else {
    const category = getClassroomNotificationType_(body);
    data = buildSingleNotificationProcessedRecord_(row, 'Google Classroom', category);
  }

  // Store derived data in its dedicated trailing column; row 16 remains the
  // established submission-event ledger and keeps its old JSON shape.
  setNotificationProcessedData_(row, data);
  return row;
}

function getNotificationProcessingColumn_(source) {
  return source === 'inCampus' ? INCAMPUS_UNIFIED_HEADERS.length : HEADER_ROW.length;
}

function buildInCampusProcessedRecord_(row, record) {
  const child = normalizeNotificationRowWidth_(row);
  child[3] = record.courseName;
  child[4] = record.title;
  child[11] = record.body;
  const explicitDeadline = String(record.body).split('\n')
    .filter(line => /^\s*(?:提出期限|期限|締切|締め切り|しめきり)\s*[:：]/.test(line)).join('\n');
  const due = extractDueDate_(explicitDeadline, row[9]);
  const isUniversityNotice = record.type === 'announcement';
  const taskRelated = record.type === 'assignment';
  const expiry = isUniversityNotice ? getInCampusNoticeExpiry_(row[9]) : null;
  return {
    version: NOTICE_PREPROCESSING_VERSION,
    type: record.type,
    category: record.type,
    isUniversityNotice,
    taskRelated,
    title: record.title,
    displayTitle: record.title,
    courseName: record.courseName,
    weekdayPeriod: record.weekdayPeriod || '',
    occurredAt: record.occurredAt instanceof Date ? record.occurredAt.toISOString() : String(record.occurredAt || ''),
    body: record.body,
    displayBody: cleanBodyForWeb_(record.body, 'inCampus'),
    classroomUrl: '',
    dueDateEpoch: due.dueDate instanceof Date ? due.dueDate.getTime() : null,
    dueDateText: due.dueDate instanceof Date ? '' : String(due.dueDate || ''),
    dueStatus: record.type === 'submission' ? '提出記録' : due.dueStatus,
    expiresAt: expiry === null ? null : expiry
  };
}

function buildSingleNotificationProcessedRecord_(row, source, category) {
  const receivedAt = parseNotificationReceivedDate_(row[9]);
  const isUniversityNotice = source === 'Google Classroom'
    ? category === 'newAnnouncement'
    : isUniversityNoticeRowLegacy_(row);
  const taskRelated = source === 'Google Classroom'
    ? category === 'newAssignment'
    : isTaskRelatedRowLegacy_(row);
  let expiresAt = null;
  if (isUniversityNotice && receivedAt) {
    if (source === 'inCampus') {
      expiresAt = getInCampusNoticeExpiry_(receivedAt);
    } else {
      const contentExpiry = getClassroomNoticeExpiry_(row[11], receivedAt);
      expiresAt = contentExpiry === null ? receivedAt.getTime() + 14 * 24 * 60 * 60 * 1000 : contentExpiry;
    }
  }
  const title = source === 'inCampus'
    ? extractInCampusTitle_(row[7], row[11])
    : String(row[7] || row[4] || '');
  return {
    version: NOTICE_PREPROCESSING_VERSION,
    source,
    category,
    isUniversityNotice,
    taskRelated,
    title,
    displayTitle: title,
    displayBody: cleanBodyForWeb_(row[11], source),
    classroomUrl: extractClassroomUrl_(source, row[11]),
    weekdayPeriod: source === 'inCampus' ? (extractRequiredInCampusFieldsFromBody_(row[11]) || {}).weekdayPeriod || '' : '',
    expiresAt
  };
}

function getInCampusNoticeExpiry_(receivedAt) {
  const parts = noticeJapanParts_(receivedAt);
  if (!parts) return null;
  const nextMonth = new Date(Date.UTC(parts.year, parts.month, 1));
  const year = nextMonth.getUTCFullYear();
  const month = nextMonth.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDay);
  return Date.UTC(year, month, day, parts.hour, parts.minute, parts.second, parts.ms) - 9 * 60 * 60 * 1000;
}

function restoreProcessedDueDate_(record) {
  if (record && Number.isFinite(record.dueDateEpoch)) return new Date(record.dueDateEpoch);
  return String(record && record.dueDateText || '');
}

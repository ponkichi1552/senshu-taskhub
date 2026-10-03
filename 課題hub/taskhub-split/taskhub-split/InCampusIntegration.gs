function validateAssignment_(assignment) {
  if ((assignment.type || 'assignment') === 'assignment' && !isInCampusReportDetailUrl_(assignment.pageUrl)) {
    throw new Error('課題詳細ページ以外は課題として保存できません。拡張機能を更新してください。');
  }
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
  return runWithUserLock_('保存データ処理', () => upsertInCampusAssignmentLocked_(assignment));
}

function upsertInCampusAssignmentLocked_(assignment) {
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
    assignment.rawText,
    assignment.updateText
  ].filter(Boolean).join('\n');
  const records = extractInCampusSubmissionRecords_(
    '',
    text,
    assignment.receivedAt || assignment.extractedAt || new Date()
  );

  if (records.length === 0) {
    return null;
  }

  const record = records[0];

  return {
    courseName: isGenericInCampusCourseNameForMatch_(normalizeInCampusCourseNameForMatch_(record.courseName)) ? assignment.courseName || '' : record.courseName,
    weekdayPeriod: record.weekdayPeriod || assignment.weekdayPeriod || '',
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
  if (sheet.getLastRow() < 2) return 0;
  const values = sheet.getDataRange().getValues();
  const type = String(assignment.type || 'assignment');
  const key = String(assignment.assignmentKey || '').trim();
  const url = String(assignment.pageUrl || '').trim();
  for (let i = 1; i < values.length; i++) {
    const row = values[i], raw = parseInCampusRawJson_(row[13]);
    if (String(row[1] || raw.type || 'assignment') !== type) continue;
    const rowKey = String(row[16] || raw.assignmentKey || '').trim();
    if (key && rowKey === key) return i + 1;
    if (type === 'assignment' && isInCampusReportDetailUrl_(url) && String(row[10] || '') === url) return i + 1;
    if (type === 'announcement' && !key && !rowKey &&
      String(row[10] || '') === url &&
      normalizeInCampusMatchText_(row[2]) === normalizeInCampusMatchText_(assignment.title) &&
      normalizeInCampusMatchText_(raw.courseName) === normalizeInCampusMatchText_(assignment.courseName) &&
      String(raw.updateAt || '') === String(assignment.updateAt || '') &&
      String(raw.updateText || '') === String(assignment.updateText || '')) return i + 1;
  }
  return 0;
}

function applySavedInCampusExtractedSubmissionRecords_(sheet) {
  return runWithUserLock_('提出記録処理', () => applySavedInCampusExtractedSubmissionRecordsLocked_(sheet));
}

function applySavedInCampusExtractedSubmissionRecordsLocked_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const values = sheet.getDataRange().getValues();
  let completedCount = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row[1] !== INCAMPUS_SUBMISSION_RECORD_TYPE && row[14] !== INCAMPUS_SUBMISSION_RECORD_STATUS) continue;
    const raw = parseInCampusRawJson_(row[13]);
    const record = extractInCampusSubmissionRecordFromAssignment_(raw) || {
      courseName: raw.courseName || '', weekdayPeriod: raw.weekdayPeriod || '', title: row[2],
      submittedAt: row[15] || row[12] || row[11] || '', pageUrl: raw.pageUrl || ''
    };
    const eventKey = buildInCampusSubmissionEventKey_(record, row[16], row[12]);
    const bindings = raw.appliedSubmissionTargets || {};
    const matches = findMatchingInCampusExtractedRecords_(values, record);
    const targets = bindings[eventKey] || matches.map(match => match.row[10]);
    if (!targets.length) continue;
    if (!bindings[eventKey]) {
      bindings[eventKey] = targets; raw.appliedSubmissionTargets = bindings;
      row[13] = JSON.stringify(raw); sheet.getRange(i + 1, 14).setValue(row[13]);
    }
    targets.forEach(url => {
      const index = values.findIndex((target, offset) => offset > 0 && target[1] === 'assignment' && String(target[10]) === String(url));
      if (index > 0 && setInCampusExtractedSubmissionStatus_(sheet, values, index, record, eventKey)) completedCount++;
    });
  }
  return completedCount;
}

function completeMatchingInCampusExtractedRow_(sheet, record) {
  return runWithUserLock_('提出記録処理', () => completeMatchingInCampusExtractedRowLocked_(sheet, record));
}

function completeMatchingInCampusExtractedRowLocked_(sheet, record) {
  if (!record || !record.title || !sheet || sheet.getLastRow() < 2) return false;
  const values = sheet.getDataRange().getValues();
  const eventKey = buildInCampusSubmissionEventKey_(record, '', record.submittedAt);
  let changed = false;
  findMatchingInCampusExtractedRecords_(values, record).forEach(match => {
    if (setInCampusExtractedSubmissionStatus_(sheet, values, match.index, record, eventKey)) changed = true;
  });
  return changed;
}

function findMatchingInCampusExtractedRecords_(values, record) {
  const candidates = [];
  values.slice(1).forEach((row, offset) => {
    if (String(row[1] || 'assignment') !== 'assignment') return;
    const raw = parseInCampusRawJson_(row[13]);
    const rowUrl = String(row[10] || '');
    const recordUrl = String(record.pageUrl || '');
    const exactReport = isInCampusReportDetailUrl_(recordUrl) && rowUrl === recordUrl;
    if (!exactReport && !isSameInCampusAssignmentForWeb_(record, {
      title: row[2] || raw.title, courseName: raw.courseName, weekdayPeriod: raw.weekdayPeriod
    })) return;
    candidates.push({index: offset + 1, row});
  });
  // Distinct report URLs with the same title/course cannot be resolved safely.
  return new Set(candidates.map(candidate => String(candidate.row[10]))).size > 1 ? [] : candidates;
}

function setInCampusExtractedSubmissionStatus_(sheet, values, index, record, eventKey) {
  const row = values[index];
  const raw = parseInCampusRawJson_(row[13]);
  const events = raw.appliedSubmissionEvents || {};
  if (events[eventKey]) return false;
  events[eventKey] = true; raw.appliedSubmissionEvents = events;
  row[13] = JSON.stringify(raw); row[14] = '完了'; row[15] = record.submittedAt || new Date();
  sheet.getRange(index + 1, 14, 1, 3).setValues([[row[13], row[14], toSafeSpreadsheetCell_(row[15])]]);
  return true;
}

function getOrCreateInCampusSheet_() {
  return runWithUserLock_('保存データ処理', () => getOrCreateInCampusSheetLocked_());
}

function getOrCreateInCampusSheetLocked_() {
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
  if (existingRow) {
    const previous = parseInCampusRawJson_(existingRow[13]);
    const merged = Object.assign({}, previous, assignment);
    ['courseName', 'weekdayPeriod', 'updateText', 'updateAction', 'updateAt', 'assignmentKey'].forEach(key => {
      if (!String(assignment[key] || '').trim()) merged[key] = previous[key] || (key === 'assignmentKey' ? existingRow[16] : '') || '';
    });
    // A detail-page manual extraction often uses its URL as a temporary key.
    if (assignment.assignmentKey === assignment.pageUrl && (previous.assignmentKey || existingRow[16])) {
      merged.assignmentKey = previous.assignmentKey || existingRow[16];
    }
    assignment = merged;
  }
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

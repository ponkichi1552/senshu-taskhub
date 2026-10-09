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

function upsertInCampusAssignments_(assignments) {
  return runWithUserLock_('保存データ処理', () => upsertInCampusAssignmentsLocked_(assignments));
}

function upsertInCampusAssignmentLocked_(assignment, spreadsheet) {
  const sheet = getOrCreateInCampusSheetLocked_(spreadsheet);
  return upsertInCampusAssignmentForSheetLocked_(sheet, assignment, false);
}

function upsertInCampusAssignmentsLocked_(assignments, spreadsheet, preparedInCampusSheet) {
  const startedAt = Date.now();
  let phaseStartedAt = startedAt;
  const phaseMs = Object.create(null);
  const sheet = preparedInCampusSheet || getOrCreateInCampusSheetLocked_(spreadsheet);
  phaseMs.prepareSheetMs = Date.now() - phaseStartedAt;
  phaseStartedAt = Date.now();
  const rows = sheet.getDataRange().getValues();
  phaseMs.readRowsMs = Date.now() - phaseStartedAt;
  phaseStartedAt = Date.now();
  const initialLastRow = rows.length;
  const changedExistingRows = new Map();
  const results = [];
  let changedCount = 0;

  assignments.forEach(assignment => {
    const prepared = prepareInCampusAssignmentUpsert_(rows, assignment);
    const result = prepared.result;
    results.push(result);
    if (!result.changed) return;

    changedCount++;
    if (!prepared.isNew && prepared.row <= initialLastRow) {
      changedExistingRows.set(prepared.row, prepared.rowValues);
    }
  });
  phaseMs.matchAndPrepareMs = Date.now() - phaseStartedAt;

  const updates = Array.from(changedExistingRows, ([row, values]) => ({row, values}));
  phaseStartedAt = Date.now();
  if (updates.length > 0) {
    if (typeof sheet.updateRows === 'function') {
      sheet.updateRows(updates);
    } else {
      updates.forEach(update => sheet.getRange(update.row, 1, 1, INCAMPUS_HEADERS.length).setValues([update.values]));
    }
  }
  phaseMs.updateRowsMs = Date.now() - phaseStartedAt;

  const newRows = rows.slice(initialLastRow);
  phaseStartedAt = Date.now();
  if (newRows.length > 0) {
    if (typeof sheet.appendRows === 'function') {
      sheet.appendRows(newRows);
    } else {
      sheet.getRange(initialLastRow + 1, 1, newRows.length, INCAMPUS_HEADERS.length).setValues(newRows);
    }
  }
  phaseMs.appendRowsMs = Date.now() - phaseStartedAt;

  phaseStartedAt = Date.now();
  if (changedCount > 0 && hasSavedInCampusSubmissionRecords_(rows)) {
    applySavedInCampusExtractedSubmissionRecordsLocked_(sheet, rows);
  }
  phaseMs.applySubmissionMs = Date.now() - phaseStartedAt;
  Logger.log('TASKHUB_INCAMPUS_BATCH_UPSERT ' + JSON.stringify({
    elapsedMs: Date.now() - startedAt,
    phaseMs,
    assignmentCount: assignments.length,
    existingUpdateCount: updates.length,
    newRowCount: newRows.length,
    changedCount,
    unchangedCount: results.length - changedCount
  }));
  return {
    results,
    changedCount,
    unchangedCount: results.length - changedCount
  };
}

function upsertInCampusAssignmentForSheetLocked_(sheet, assignment, deferSubmissionApply) {
  const rows = sheet.getDataRange().getValues();
  const prepared = prepareInCampusAssignmentUpsert_(rows, assignment);
  if (!prepared.result.changed) return prepared.result;

  if (prepared.isNew) {
    sheet.appendRow(prepared.rowValues);
  } else {
    sheet.getRange(prepared.row, 1, 1, INCAMPUS_HEADERS.length).setValues([prepared.rowValues]);
  }

  if (!deferSubmissionApply && hasSavedInCampusSubmissionRecords_(rows)) {
    applySavedInCampusExtractedSubmissionRecordsLocked_(sheet, rows);
  }
  return prepared.result;
}

function prepareInCampusAssignmentUpsert_(rows, assignment) {
  const submissionRecord = extractInCampusSubmissionRecordFromAssignment_(assignment);
  let rowAssignment = assignment;

  if (submissionRecord) {
    rowAssignment = buildInCampusSubmissionRecordMarkerAssignment_(assignment, submissionRecord);
  }

  const existingRowNumber = findExistingInCampusAssignmentRowInValues_(rows, rowAssignment);

  if (existingRowNumber) {
    const existingRow = rows[existingRowNumber - 1];
    const rowValues = buildAssignmentRow_(rowAssignment, existingRow);
    if (areInCampusAssignmentRowsEquivalent_(existingRow, rowValues)) {
      return {
        result: {updated: true, unchanged: true, changed: false, row: existingRowNumber},
        isNew: false,
        row: existingRowNumber,
        rowValues: existingRow
      };
    }
    rows[existingRowNumber - 1] = rowValues;
    return {
      result: {updated: true, unchanged: false, changed: true, row: existingRowNumber},
      isNew: false,
      row: existingRowNumber,
      rowValues
    };
  }

  const rowValues = buildAssignmentRow_(rowAssignment);
  rows.push(rowValues);
  return {
    result: {updated: false, unchanged: false, changed: true, row: rows.length},
    isNew: true,
    row: rows.length,
    rowValues
  };
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
    assignment.submittedAt || assignment.updateAt || assignment.receivedAt || assignment.extractedAt || new Date()
  );

  if (records.length === 0) {
    return null;
  }

  const record = records[0];

  return {
    courseName: isGenericInCampusCourseNameForMatch_(normalizeInCampusCourseNameForMatch_(record.courseName)) ? assignment.courseName || '' : record.courseName,
    weekdayPeriod: record.weekdayPeriod || assignment.weekdayPeriod || '',
    title: record.title,
    submittedAt: record.submittedAt || assignment.submittedAt || assignment.updateAt || assignment.receivedAt || '',
    pageUrl: assignment.pageUrl || ''
  };
}

function buildInCampusSubmissionRecordMarkerAssignment_(assignment, record) {
  return Object.assign({}, assignment, {
    type: INCAMPUS_SUBMISSION_RECORD_TYPE,
    title: record.title,
    body: assignment.body || assignment.title || '',
    pageUrl: buildInCampusSubmissionRecordPageUrl_(assignment, record),
    assignmentKey: buildInCampusSubmissionRecordAssignmentKey_(assignment, record),
    status: INCAMPUS_SUBMISSION_RECORD_STATUS,
    completedAt: record.submittedAt || assignment.submittedAt || assignment.updateAt || assignment.receivedAt || ''
  });
}

function buildInCampusSubmissionRecordPageUrl_(assignment, record) {
  const baseUrl = assignment.pageUrl || 'incampus-submission';
  const key = [
    assignment.assignmentKey || assignment.updateInfoId || assignment.reportId || '',
    record.title,
    record.submittedAt || assignment.submittedAt || assignment.updateAt || assignment.receivedAt || ''
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
    record.submittedAt || assignment.submittedAt || assignment.updateAt || assignment.receivedAt || ''
  ].filter(Boolean);

  return parts.length > 2 ? parts.join(':') : '';
}

function findExistingInCampusAssignmentRow_(sheet, assignment) {
  if (sheet.getLastRow() < 2) return 0;
  return findExistingInCampusAssignmentRowInValues_(sheet.getDataRange().getValues(), assignment);
}

function findExistingInCampusAssignmentRowInValues_(values, assignment) {
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

function hasSavedInCampusSubmissionRecords_(values) {
  return values.some((row, index) => index > 0 &&
    (row[1] === INCAMPUS_SUBMISSION_RECORD_TYPE || row[14] === INCAMPUS_SUBMISSION_RECORD_STATUS));
}

function areInCampusAssignmentRowsEquivalent_(existingRow, nextRow) {
  const volatileColumns = new Set([11, 12]); // extractedAt / savedAt

  for (let index = 0; index < INCAMPUS_HEADERS.length; index++) {
    if (volatileColumns.has(index)) continue;

    if (index === 13) {
      const existingRaw = parseInCampusRawJson_(existingRow[index]);
      const nextRaw = parseInCampusRawJson_(nextRow[index]);
      delete existingRaw.extractedAt;
      delete nextRaw.extractedAt;
      if (stableInCampusJson_(existingRaw) !== stableInCampusJson_(nextRaw)) return false;
      continue;
    }

    const existingValue = existingRow[index];
    const nextValue = nextRow[index];
    // Sheets coerces date-shaped input strings to Date cells. Compare their
    // value, so an identical deadline does not rewrite rows and all displays.
    const normalizeCell = value => {
      if ([4, 5, 15].includes(index)) {
        if (value instanceof Date && !Number.isNaN(value.getTime())) return `date:${value.getTime()}`;
        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+Z|Z)?$/.test(String(value || ''))) {
          const date = new Date(value);
          if (!Number.isNaN(date.getTime())) return `date:${date.getTime()}`;
        }
      }
      return value instanceof Date ? `date:${value.getTime()}` : String(value ?? '');
    };
    const normalizedExisting = normalizeCell(existingValue);
    const normalizedNext = normalizeCell(nextValue);
    if (normalizedExisting !== normalizedNext) return false;
  }

  return true;
}

function stableInCampusJson_(value) {
  if (Array.isArray(value)) return value.map(stableInCampusJson_);
  if (value && typeof value === 'object') {
    const sorted = {};
    Object.keys(value).sort().forEach(key => {
      if (value[key] === '' || value[key] === null || value[key] === undefined) return;
      sorted[key] = stableInCampusJson_(value[key]);
    });
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value);
}

function applySavedInCampusExtractedSubmissionRecords_(sheet, values) {
  return runWithUserLock_('提出記録処理', () => applySavedInCampusExtractedSubmissionRecordsLocked_(sheet, values));
}

function applySavedInCampusExtractedSubmissionRecordsLocked_(sheet, preloadedValues) {
  if (!sheet) return 0;
  const values = Array.isArray(preloadedValues) ? preloadedValues : sheet.getDataRange().getValues();
  if (values.length < 2) return 0;
  let completedCount = 0;
  const changedRows = new Map();
  const assignmentIndexByUrl = new Map();
  for (let index = 1; index < values.length; index++) {
    if (values[index][1] === 'assignment' && values[index][10] && !assignmentIndexByUrl.has(String(values[index][10]))) {
      assignmentIndexByUrl.set(String(values[index][10]), index);
    }
  }

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
    const targets = bindings[eventKey] || findMatchingInCampusExtractedRecords_(values, record).map(match => match.row[10]);
    if (!targets.length) continue;
    if (!bindings[eventKey]) {
      bindings[eventKey] = targets; raw.appliedSubmissionTargets = bindings;
      row[13] = JSON.stringify(raw);
      changedRows.set(i + 1, row);
    }
    targets.forEach(url => {
      const index = assignmentIndexByUrl.get(String(url));
      if (index > 0 && setInCampusExtractedSubmissionStatus_(sheet, values, index, record, eventKey, true)) {
        completedCount++;
        changedRows.set(index + 1, values[index]);
      }
    });
  }

  if (changedRows.size > 0) {
    const updates = Array.from(changedRows, ([row, values]) => ({row, values: toSafeSpreadsheetRow_(values)}));
    if (typeof sheet.updateRows === 'function') {
      sheet.updateRows(updates);
    } else {
      updates.forEach(update => sheet.getRange(update.row, 14, 1, 3).setValues([update.values.slice(13, 16)]));
    }
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

function setInCampusExtractedSubmissionStatus_(sheet, values, index, record, eventKey, deferWrite) {
  const row = values[index];
  const raw = parseInCampusRawJson_(row[13]);
  const events = raw.appliedSubmissionEvents || {};
  if (events[eventKey]) return false;
  events[eventKey] = true; raw.appliedSubmissionEvents = events;
  row[13] = JSON.stringify(raw); row[14] = '完了'; row[15] = record.submittedAt || new Date();
  if (!deferWrite) sheet.getRange(index + 1, 14, 1, 3).setValues([[row[13], row[14], toSafeSpreadsheetCell_(row[15])]]);
  return true;
}

function getOrCreateInCampusSheet_() {
  return runWithUserLock_('保存データ処理', () => getOrCreateInCampusSheetLocked_());
}

function getOrCreateInCampusSheetLocked_(spreadsheet) {
  const ss = spreadsheet || getTargetSpreadsheet_();
  const unifiedSheet = getOrCreateInCampusUnifiedSheetLocked_(ss);
  return createInCampusExtractSheetAdapter_(unifiedSheet);
}

function getTargetSpreadsheet_() {
  return getOrCreateSpreadsheet_();
}

function setupInCampusHeader_(sheet) {
  if (sheet && sheet.__inCampusExtractAdapter) return;
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
  const isCompleted = status === '完了' || status === INCAMPUS_SUBMISSION_RECORD_STATUS;
  const completedAt = isCompleted
    ? existingCompletedAt || assignment.completedAt || (status === '完了' ? now : '')
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

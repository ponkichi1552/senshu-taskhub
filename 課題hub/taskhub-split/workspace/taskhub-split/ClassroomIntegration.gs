function completeClassroomAssignments_(records) {
  return runWithUserLock_('保存データ処理', () => completeClassroomAssignmentsLocked_(records));
}

function completeClassroomAssignmentsLocked_(records) {
  if (!Array.isArray(records)) {
    throw new Error('recordsが配列ではありません。');
  }

  const ss = getOrCreateSpreadsheet_();
  const sheet = ensureNotificationStorage_(ss)['Google Classroom'];

  if (records.length === 0) {
    return {
      foundCount: records.length,
      matchedCount: 0,
      unmatchedCount: records.length,
      results: records.map(record => buildClassroomCompletionResult_(record, false, 'Classroom通知に対象行がありません。'))
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
  return runWithUserLock_('保存データ処理', () => updateClassroomDueTimesLocked_(records));
}

function updateClassroomDueTimesLocked_(records) {
  if (!Array.isArray(records)) {
    throw new Error('recordsが配列ではありません。');
  }

  const ss = getOrCreateSpreadsheet_();
  const sheet = ensureNotificationStorage_(ss)['Google Classroom'];

  if (records.length === 0) {
    return {
      foundCount: records.length,
      matchedCount: 0,
      unmatchedCount: records.length,
      dueTimeCount: records.filter(record => record && record.dueTime).length,
      results: records.map(record => buildClassroomDueTimeResult_(record, false, 'Classroom通知に対象行がありません。'))
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
  const matches = findMatchingClassroomNotificationRows_(values, record, {allowTextFallback: false});
  if (!matches.length) return buildClassroomDueTimeResult_(record, false, 'Classroom通知に一致するClassroom課題がないため更新しませんでした。');
  let savedDueValue = '';
  const updatedRows = [];
  matches.forEach(match => {
    const dueValue = buildClassroomDueDateValue_(record, values[match.index][5]);
    if (!dueValue) return;
    // Strings without times retain their date-only meaning even after sync.
    const hasTime = dueValue instanceof Date || /\s\d{1,2}:\d{2}$/.test(String(dueValue));
    const status = hasTime ? 'Classroomで時刻補正' : 'Classroomで日付補正';
    sheet.getRange(match.index + 1, 6, 1, 2).setValues([[toSafeSpreadsheetCell_(dueValue), status]]);
    values[match.index][5] = dueValue; values[match.index][6] = status;
    savedDueValue = dueValue; updatedRows.push(match.index + 1);
  });
  const result = buildClassroomDueTimeResult_(record, updatedRows.length > 0, updatedRows.length ? '' : '更新できる期限情報がありません。', updatedRows[0], savedDueValue);
  result.rows = updatedRows;
  return result;
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

function findMatchingClassroomNotificationRows_(values, record, options) {
  const allowTextFallback = !(options && options.allowTextFallback === false);
  const recordUrl = normalizeClassroomUrlForMatch_(record.classroomUrl || record.pageUrl);
  const recordIds = getClassroomRecordIds_(record);
  const recordTitle = normalizeInCampusMatchText_(record.title);
  const recordCourseName = normalizeClassroomCourseNameForMatch_(record.courseName);
  const recordSyntheticMessageId = buildClassroomSyntheticMessageId_(record);
  const matches = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const source = String(row[2] || '');

    if (source !== 'Google Classroom') {
      continue;
    }

    if (!isTaskRelatedRow_(row)) {
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
      matches.push({index: i, row});
    }
  }
  return matches;
}

function findMatchingClassroomNotificationRow_(values, record, options) {
  return findMatchingClassroomNotificationRows_(values, record, options)[0] || null;
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
  const dueAtText = String(record.dueAt || '').trim();
  const dateOnlyAt = dueAtText.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (dateOnlyAt && isValidDateParts_(Number(dateOnlyAt[1]), Number(dateOnlyAt[2]), Number(dateOnlyAt[3]))) {
    return dueTime ? buildDateWithTime_(dateOnlyAt[1], dateOnlyAt[2], dateOnlyAt[3], dueTime)
      : formatDueDate_(dateOnlyAt[1], dateOnlyAt[2], dateOnlyAt[3], '');
  }
  const dueAtDate = !dateOnlyAt ? parseClassroomDate_(record.dueAt) : null;
  if (dueAtDate) return dueAtDate;

  const dueDateText = String(record.dueDate || '').trim();
  const provided = dueDateText.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (provided && isValidDateParts_(Number(provided[1]), Number(provided[2]), Number(provided[3]))) {
    return dueTime ? buildDateWithTime_(provided[1], provided[2], provided[3], dueTime)
      : formatDueDate_(provided[1], provided[2], provided[3], '');
  }
  // Date-only pages omit today's date. Preserve the ORIGINAL date stored in the
  // sheet here, not the prior-day presentation of a known midnight deadline.
  const existing = getOriginalDueDateParts_(existingDueValue);
  if (existing && dueTime) return buildDateWithTime_(existing.year, existing.month, existing.day, dueTime);
  if (record.dueText) {
    const parsed = parseDueDateTextForWeb_(String(record.dueText).trim());
    if (parsed && parsed.dueType === 'detected') return String(record.dueText).trim();
  }
  return '';
}

function getOriginalDueDateParts_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate()};
  }
  const match = String(value || '').match(/^(\d{4})[\/年-]\s*(\d{1,2})[\/月-]\s*(\d{1,2})(?:日|\s|$)/);
  if (!match || !isValidDateParts_(Number(match[1]), Number(match[2]), Number(match[3]))) return null;
  return {year: Number(match[1]), month: Number(match[2]), day: Number(match[3])};
}

function parseClassroomDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  if (!value) {
    return null;
  }

  const explicitDate = String(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:T|\s|$)/);
  if (explicitDate && !isValidDateParts_(Number(explicitDate[1]), Number(explicitDate[2]), Number(explicitDate[3]))) return null;
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
  const matches = findMatchingClassroomNotificationRows_(values, record, {allowTextFallback: false});
  if (!matches.length) return buildClassroomCompletionResult_(record, false, 'Classroom通知に一致するClassroom課題がないため完了にしませんでした。');
  const providedCompletedAt = parseClassroomDate_(record && record.completedAt);
  const existingCompletedAt = matches.map(match => parseClassroomDate_(values[match.index][13])).find(Boolean);
  const completedAt = providedCompletedAt || existingCompletedAt || new Date();
  matches.forEach(match => {
    sheet.getRange(match.index + 1, 13, 1, 2).setValues([['完了', completedAt]]);
    values[match.index][12] = '完了'; values[match.index][13] = completedAt;
  });
  const result = buildClassroomCompletionResult_(record, true, '', matches[0].index + 1);
  result.rows = matches.map(match => match.index + 1);
  return result;
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

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
  if (/^\s*お知らせ内容\s*[:：]/m.test(String(body || ''))) return subject || 'タイトル未抽出';
  const updateLines = getInCampusUpdateLines_(body);

  for (const line of updateLines) {
    const title = extractInCampusUpdateTitle_(line);

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

function getInCampusUpdateKind_(value) {
  const prefix = String(value || '').trim().replace(/^[・･·\s]+/, '').slice(0, 2);
  return prefix === '課題' ? 'assignment' : prefix === 'お知' ? 'announcement' : '';
}

function extractInCampusUpdateTitle_(value) {
  const text = String(value || '').trim().replace(/^[・･·\s]+/, '');
  const match = text.match(/^(?:課題|お知らせ)\s*[（(](.*)[）)]\s*(?:が|を)/) ||
    text.match(/^(?:課題|お知らせ)\s*[「『](.*)[」』]\s*(?:が|を)/);
  return match ? match[1].trim() : '';
}

function getInCampusMailKind_(body) {
  const fields = extractRequiredInCampusFieldsFromBody_(body);
  if (fields) return getInCampusUpdateKind_(fields.updateContent);
  const lines = getCleanLines_(body);
  if (lines.some(line => /^お知らせ内容\s*[:：]/.test(line))) return 'announcement';
  const marker = lines.findIndex(line => /^更新内容\s*[:：]/.test(line));
  if (marker >= 0) {
    const line = lines[marker].replace(/^更新内容\s*[:：]\s*/, '') || lines[marker + 1] || '';
    return getInCampusUpdateKind_(line);
  }
  return '';
}

function extractInCampusAddedItemTitle_(line) {
  if (getInCampusUpdateKind_(line) !== 'assignment' || !/が(?:追加|更新)されました/.test(line)) return '';
  return extractInCampusUpdateTitle_(line);
}

function isInCampusTaskRelated_(subject, body) {
  const text = `${subject || ''}\n${body || ''}`;

  if (isNonActionableNotification_(text)) {
    return false;
  }

  const lines = getInCampusUpdateLines_(body);

  return lines.some(line => extractInCampusAddedItemTitle_(line) !== '');
}

function extractRequiredInCampusFieldsFromBody_(body) {
  const lines = getCleanLines_(body);
  let fields = {
    weekdayPeriod: '',
    courseName: '',
    teacherName: '',
    updateContent: ''
  };

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '').trim();
    let match = line.match(/^(?:曜日・時限|時限・曜日)\s*[:：]\s*(.+)$/);

    if (match) {
      fields = {
        weekdayPeriod: String(match[1] || '').trim(),
        courseName: '',
        teacherName: '',
        updateContent: ''
      };
      continue;
    }

    match = line.match(/^授業名\s*[:：]\s*(.+)$/);

    if (match) {
      fields.courseName = String(match[1] || '').trim();
      continue;
    }

    match = line.match(/^(?:教員名|発信者)\s*[:：]\s*(.+)$/);

    if (match) {
      fields.teacherName = String(match[1] || '').trim();
      continue;
    }

    match = line.match(/^更新内容\s*[:：]\s*(.*)$/);

    if (!match) {
      continue;
    }

    const inlineContent = String(match[1] || '').trim();
    const nextLine = inlineContent || String(lines[i + 1] || '').trim();

    if (
      !nextLine ||
      /^(曜日・時限|授業名|教員名|更新内容)\s*[:：]/.test(nextLine) ||
      /^=+$/.test(nextLine) ||
      nextLine.startsWith('※※')
    ) {
      continue;
    }

    fields.updateContent = nextLine;

    if (
      fields.weekdayPeriod &&
      fields.courseName &&
      fields.teacherName &&
      fields.updateContent
    ) {
      return fields;
    }
  }

  return null;
}

function extractInCampusMailRecords_(subject, body, receivedDate) {
  const lines = getCleanLines_(`${subject || ''}\n${body || ''}`);
  const records = [];
  let weekdayPeriod = '';
  let courseName = '';
  let teacherName = '';

  lines.forEach(line => {
    const text = String(line || '').trim();
    let match = text.match(/^(?:曜日・時限|時限・曜日)\s*[:：]\s*(.+)$/);

    if (match) {
      weekdayPeriod = String(match[1] || '').trim();
      courseName = '';
      teacherName = '';
      return;
    }

    match = text.match(/^授業名\s*[:：]\s*(.+)$/);

    if (match) {
      courseName = String(match[1] || '').trim();
      return;
    }

    match = text.match(/^(?:教員名|発信者)\s*[:：]\s*(.+)$/);

    if (match) {
      teacherName = String(match[1] || '').trim();
      return;
    }

    const bracketCourseName = extractInCampusCourseNameFromBracketLine_(text);

    if (bracketCourseName) {
      courseName = bracketCourseName;
      return;
    }

    const addedTitle = extractInCampusAddedItemTitle_(text);
    const submittedTitle = extractInCampusSubmittedItemTitle_(text);
    const announcementTitle = getInCampusUpdateKind_(text) === 'announcement' ? extractInCampusUpdateTitle_(text) : '';

    if (!addedTitle && !submittedTitle && !announcementTitle) {
      return;
    }

    const recordType = submittedTitle ? 'submission' : announcementTitle ? 'announcement' : 'assignment';
    const title = submittedTitle || addedTitle || announcementTitle;

    records.push({
      type: recordType,
      weekdayPeriod,
      teacherName,
      courseName: courseName || 'inCampusお知らせ',
      title,
      occurredAt: extractDateTimeFromInCampusLine_(text, receivedDate),
      body: buildInCampusMailRecordBody_(weekdayPeriod, courseName, teacherName, text)
    });
  });

  return deduplicateInCampusMailRecords_(records);
}

function buildInCampusMailRecordBody_(weekdayPeriod, courseName, teacherName, updateLine) {
  return [
    weekdayPeriod ? `曜日・時限：${weekdayPeriod}` : '',
    courseName ? `授業名：${courseName}` : '',
    teacherName ? `教員名：${teacherName}` : '',
    '更新内容：',
    updateLine
  ].filter(Boolean).join('\n');
}

function extractInCampusSubmissionRecords_(subject, body, receivedDate) {
  return extractInCampusMailRecords_(subject, body, receivedDate)
    .filter(record => record.type === 'submission')
    .map(record => ({
      courseName: record.courseName,
      weekdayPeriod: record.weekdayPeriod,
      title: record.title,
      submittedAt: record.occurredAt,
      body: record.body
    }));
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

function extractDateTimeFromInCampusLine_(line, receivedDate) {
  const text = String(line || '');
  let match = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:\d{2})/);

  if (match) {
    return buildDateWithTime_(match[1], match[2], match[3], match[4]);
  }

  match = text.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:\d{2})(?!\d)/);

  if (!match) {
    return '';
  }

  const parsedReceivedDate = receivedDate instanceof Date
    ? receivedDate
    : new Date(receivedDate);
  const baseDate = Number.isNaN(parsedReceivedDate.getTime())
    ? new Date()
    : parsedReceivedDate;
  const resolveYear = createMonthDayYearResolver_(baseDate);
  const year = resolveYear(match[1], match[2]);

  return buildDateWithTime_(year, match[1], match[2], match[3]);
}

function applySavedInCampusSubmissionRecords_(sheet) {
  return runWithUserLock_('保存データ処理', () => applySavedInCampusSubmissionRecordsLocked_(sheet));
}

function applySavedInCampusSubmissionRecordsLocked_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const values = sheet.getDataRange().getValues();
  let completedCount = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[2]) !== 'inCampus') continue;
    const ledger = parseInCampusRawJson_(row[15]);
    extractInCampusSubmissionRecords_(row[7], row[11], row[9]).forEach(record => {
      const eventKey = buildInCampusSubmissionEventKey_(record, row[1], row[9]);
      const existingTargets = ledger[eventKey];
      const candidates = findMatchingInCampusMailRecords_(values, record, row[9]);
      const targets = Array.isArray(existingTargets) ? existingTargets : candidates.map(target => target.row[1]);
      if (!targets.length) return; // Retry an unmatched event after older mail arrives.
      if (!existingTargets) {
        ledger[eventKey] = targets;
        row[15] = JSON.stringify(ledger);
        // Bind first, so a retry after a partial failure can never choose another task.
        sheet.getRange(i + 1, 16).setValue(row[15]);
      }
      targets.forEach(targetId => {
        const target = findInCampusLogicalRecordById_(values, targetId);
        if (target && setInCampusLogicalRecordStatus_(sheet, values, target, '完了', record.submittedAt || row[9], eventKey)) completedCount++;
      });
    });
  }
  return completedCount;
}

function completeMatchingInCampusMailRow_(sheet, record, fallbackCompletedAt) {
  return runWithUserLock_('保存データ処理', () => completeMatchingInCampusMailRowLocked_(sheet, record, fallbackCompletedAt));
}

function completeMatchingInCampusMailRowLocked_(sheet, record, fallbackCompletedAt) {
  if (!record || !record.title || !sheet || sheet.getLastRow() < 2) return false;
  const values = sheet.getDataRange().getValues();
  const eventKey = buildInCampusSubmissionEventKey_(record, '', fallbackCompletedAt);
  let changed = false;
  findMatchingInCampusMailRecords_(values, record, fallbackCompletedAt).forEach(target => {
    if (setInCampusLogicalRecordStatus_(sheet, values, target, '完了', record.submittedAt || fallbackCompletedAt || new Date(), eventKey)) changed = true;
  });
  return changed;
}

// The source email remains intact; only independent logical states are stored beside it.
function inCampusStableKey_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('').slice(0, 32);
}

function inCampusRecordIdentity_(record) {
  const course = getInCampusCourseIdentity_(record);
  return [record.type, normalizeInCampusMatchText_(course.name), course.schedule,
    normalizeInCampusMatchText_(record.title), record.type === 'submission' ? getTimeForSort_(record.occurredAt) : ''].join('|');
}

function deduplicateInCampusMailRecords_(records) {
  const byIdentity = new Map();
  records.forEach(record => {
    const identity = inCampusRecordIdentity_(record);
    const previous = byIdentity.get(identity);
    // Added + updated in one email refers to the same logical assignment.
    if (previous) record.occurredAt = previous.occurredAt || record.occurredAt;
    byIdentity.set(identity, record);
  });
  return Array.from(byIdentity.values());
}

function getLegacyInCampusRecordIndex_(row, records) {
  const index = records.findIndex(record => normalizeInCampusMatchText_(record.title) === normalizeInCampusMatchText_(row[4]) &&
    normalizeInCampusCourseNameForMatch_(record.courseName) === normalizeInCampusCourseNameForMatch_(row[3]));
  return index >= 0 ? index : 0;
}

function expandInCampusNotificationRow_(row) {
  if (String(row[2]) !== 'inCampus') return [row];
  const records = extractInCampusMailRecords_(row[7], row[11], row[9]);
  if (!records.length) return [row];
  const states = parseInCampusRawJson_(row[14]);
  const legacyIndex = getLegacyInCampusRecordIndex_(row, records);
  return records.map((record, index) => {
    const child = normalizeNotificationRowWidth_(row);
    const key = inCampusStableKey_(inCampusRecordIdentity_(record));
    const state = states[key] || {};
    child[1] = String(row[1]) + ':update:' + key;
    child.originalMessageIdForState = index === legacyIndex ? String(row[1]) : '';
    child[3] = record.courseName;
    child[4] = record.title;
    child[11] = record.body;
    // Update timestamps describe delivery events, not submission deadlines.
    const explicitDeadline = String(record.body).split('\n').filter(line => /^\s*(?:提出期限|期限|締切|締め切り|しめきり)\s*[:：]/.test(line)).join('\n');
    const due = extractDueDate_(explicitDeadline, row[9]);
    child[5] = due.dueDate;
    child[6] = record.type === 'submission' ? '提出記録' : due.dueStatus;
    child[12] = state.status || (record.type === 'submission' ? '完了記録' : index === legacyIndex ? row[12] : '未確認');
    child[13] = Object.prototype.hasOwnProperty.call(state, 'completedAt') ? state.completedAt : index === legacyIndex ? row[13] : '';
    return child;
  });
}

function findInCampusLogicalRecordById_(values, messageId) {
  for (let index = 1; index < values.length; index++) {
    if (String(values[index][2]) !== 'inCampus') continue;
    const children = expandInCampusNotificationRow_(values[index]);
    const row = children.find(child => String(child[1]) === String(messageId));
    if (row) return {index, row};
  }
  return null;
}

function buildInCampusSubmissionEventKey_(record, fallbackId, fallbackTime) {
  return inCampusStableKey_([normalizeInCampusMatchText_(record.courseName),
    getInCampusCourseIdentity_(record).schedule, normalizeInCampusMatchText_(record.title),
    getTimeForSort_(record.submittedAt || fallbackTime) || String(fallbackId || '')].join('|'));
}

function findMatchingInCampusMailRecords_(values, record, fallbackTime) {
  const submittedAt = getTimeForSort_(record.submittedAt || fallbackTime);
  const matches = [];
  values.slice(1).forEach((raw, offset) => {
    if (String(raw[2]) !== 'inCampus') return;
    const records = extractInCampusMailRecords_(raw[7], raw[11], raw[9]);
    expandInCampusNotificationRow_(raw).forEach((row, recordIndex) => {
      if (!isTaskRelatedRow_(row)) return;
      const fields = extractRequiredInCampusFieldsFromBody_(row[11]) || {};
      if (!isSameInCampusAssignmentForWeb_(record, {title: row[4], courseName: row[3], weekdayPeriod: fields.weekdayPeriod})) return;
      const occurredAt = getTimeForSort_(records[recordIndex] && records[recordIndex].occurredAt || raw[9]);
      if (submittedAt && occurredAt && occurredAt > submittedAt) return;
      matches.push({index: offset + 1, row, occurredAt});
    });
  });
  if (!matches.length) return [];
  // A reused title must not cause an old submission to complete a newer assignment.
  const latest = Math.max(...matches.map(match => match.occurredAt));
  const candidates = matches.filter(match => match.occurredAt === latest);
  const schedules = new Set(candidates.map(match => getInCampusCourseIdentity_({courseName: match.row[3],
    weekdayPeriod: (extractRequiredInCampusFieldsFromBody_(match.row[11]) || {}).weekdayPeriod}).schedule));
  return schedules.size > 1 ? [] : candidates;
}

function setInCampusLogicalRecordStatus_(sheet, values, target, status, completedAt, eventKey) {
  const raw = values[target.index];
  const states = parseInCampusRawJson_(raw[14]);
  const suffix = String(target.row[1]).split(':update:')[1];
  const key = suffix || 'legacy';
  const state = states[key] || {};
  const events = state.appliedSubmissionEvents || {};
  if (eventKey && events[eventKey]) return false;
  if (eventKey) events[eventKey] = true;
  states[key] = Object.assign({}, state, {status, completedAt: status === '完了' ? completedAt || new Date() : '', appliedSubmissionEvents: events});
  raw[14] = JSON.stringify(states);
  sheet.getRange(target.index + 1, 15).setValue(raw[14]);
  if (!suffix) {
    raw[12] = status;
    raw[13] = status === '完了' ? completedAt || new Date() : '';
    sheet.getRange(target.index + 1, 13, 1, 2).setValues([[raw[12], raw[13]]]);
  }
  return true;
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

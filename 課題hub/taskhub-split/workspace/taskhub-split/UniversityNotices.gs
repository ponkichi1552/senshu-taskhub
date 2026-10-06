function getUniversityNoticesForWeb() {
  return getUniversityNoticesForWebLocked_();
}

function getUniversityNoticesForWebLocked_() {
  const startedAt = Date.now();
  const testMode = isTestCaseModeEnabled_();
  const now = testMode ? getTestCaseReferenceNow_() : new Date();
  const testSpreadsheet = testMode ? openTestCaseSpreadsheet_() : null;
  const testDateContext = testMode ? getTestCaseDateContext_(testSpreadsheet, now) : null;
  const testStates = testMode ? getTestNotificationStateMap_() : null;
  const states = PropertiesService.getUserProperties().getProperties();
  const readContext = createNotificationReadContext_(testSpreadsheet, testMode);
  const contextReadyAt = Date.now();

  const noticeRows = getNotificationRowsFromSheets_(
    readContext.sheetsBySource,
    testMode,
    testDateContext,
    readContext,
    {includeClassroomApi: false, mergeClassroomApiAssignments: false}
  );
  const rowsReadyAt = Date.now();
  const notices = noticeRows
    .filter(row => isUniversityNoticeRow_(row))
    .filter(row => isUniversityNoticeVisible_(row, now))
    .map(row => {
      const notice = rowToUniversityNotice_(row);
      let state = {};
      const statePrefix = getUniversityNoticeStatePrefix_();
      const storedState = states[statePrefix + notice.messageId] ||
        (row.originalMessageIdForState ? states[statePrefix + row.originalMessageIdForState] : '') || '{}';
      try { state = JSON.parse(storedState); } catch (_) {}
      return Object.assign(notice, {read: Boolean(state.read), saved: Boolean(state.saved)});
    })
    .sort((a, b) => b.receivedAtTime - a.receivedAtTime);
  const noticesReadyAt = Date.now();
  const extractedItems = getInCampusSupplementItemsForWeb_(testSpreadsheet, testStates, testDateContext, readContext);
  const extractedReadyAt = Date.now();
  const result = mergeNotificationAndInCampusExtractedItemsForWeb_(
    notices,
    extractedItems,
    'announcement',
    testMode
  );
  Logger.log('TASKHUB_UNIVERSITY_NOTICE_READ_TIMING ' + JSON.stringify({
    mode: testMode ? 'test' : 'personal',
    contextMs: contextReadyAt - startedAt,
    sourceRowsMs: rowsReadyAt - contextReadyAt,
    noticeFilterAndMappingMs: noticesReadyAt - rowsReadyAt,
    inCampusExtractMappingMs: extractedReadyAt - noticesReadyAt,
    mergeMs: Date.now() - extractedReadyAt,
    totalMs: Date.now() - startedAt,
    sheetReadMs: readContext.sheetReadMs,
    sheetRowCounts: readContext.sheetRowCounts,
    itemCounts: {sourceRows: noticeRows.length, notices: notices.length, inCampusExtracts: extractedItems.length, returned: result.length},
    classroomApiAssignmentsRead: false
  }));
  return result;
}

function isUniversityNoticeRow_(row) {
  const source = String(row[2] || '');
  const body = String(row[11] || '');

  if (source === 'inCampus') {
    const kind = getInCampusMailKind_(body);
    if (kind) return kind === 'announcement';
    // General university mail has no course-update labels. Keep that mail too,
    // while explicit update categories (materials/surveys etc.) remain excluded.
    if (/^\s*更新内容\s*[:：]/m.test(body)) return false;
    if (getCleanLines_(body).some(line => /^[・･·\s]*(?:課題|資料|教材|授業アンケート)\s*[（(「『]/.test(line))) return false;
    return String(row[6] || '') !== '提出記録' && String(row[12] || '') !== '完了記録';
  }

  if (source === 'Google Classroom') {
    return getClassroomNotificationType_(body) === 'newAnnouncement';
  }

  return false;
}

function rowToUniversityNotice_(row) {
  const source = String(row[2] || '');

  return {
    messageId: String(row[1] || ''),
    source,
    title: source === 'inCampus' ? extractInCampusTitle_(row[7], row[11]) : String(row[7] || row[4] || ''),
    courseName: String(row[3] || ''),
    from: String(row[8] || ''),
    receivedAt: formatDateForWeb_(row[9]),
    receivedAtTime: getTimeForSort_(row[9]),
    gmailLink: String(row[10] || ''),
    body: cleanBodyForWeb_(row[11], source)
  };
}

function setUniversityNoticeState(messageId, state) {
  return runWithUserLock_('大学のお知らせ', () => setUniversityNoticeStateLocked_(messageId, state));
}

function setUniversityNoticeStateLocked_(messageId, state) {
  if (typeof messageId !== 'string' || !messageId || messageId.length > 200 || !state || typeof state.read !== 'boolean' || typeof state.saved !== 'boolean') throw new Error('Invalid notice state');
  PropertiesService.getUserProperties().setProperty(getUniversityNoticeStatePrefix_() + messageId, JSON.stringify({read: state.read, saved: state.saved}));
  return true;
}

function getUniversityNoticeStatePrefix_() {
  return isTestCaseModeEnabled_() ? 'universityNotice:test:' : 'universityNotice:';
}

// All visibility boundaries use Japan time, independent of the script timezone.
function noticeJapanParts_(value) {
  const date = parseNotificationReceivedDate_(value);
  if (!date) return null;
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(), ms: shifted.getUTCMilliseconds()};
}

function noticeDayEndExclusive_(year, month, day) {
  const check = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2200 || check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
  return Date.UTC(year, month - 1, day + 1) - 9 * 60 * 60 * 1000;
}

function getClassroomNoticeExpiry_(body, receivedAt) {
  const base = noticeJapanParts_(receivedAt);
  if (!base) return null;
  // Remove delivery metadata and URLs so posted dates / URL digits are not deadlines.
  const text = cleanBodyForWeb_(body, 'Google Classroom').normalize('NFKC')
    .split(/\r?\n/).filter(line => !/^\s*(?:投稿日|投稿日時|送信日時)\s*[:：]/.test(line)).join('\n')
    .replace(/https?:\/\/[^\s<>]+/g, '')
    .replace(/令和\s*(\d+)年/g, (_, year) => (2018 + Number(year)) + '年');
  const dates = [];
  // Consume full dates as one token; do not reread their month/day as a second date.
  const pattern = /(?<![\d/.-])(?:(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|(\d{4})[/-](\d{1,2})[/-](\d{1,2})|(\d{1,2})\s*月\s*(\d{1,2})\s*日|(\d{1,2})\/(\d{1,2}))(?![\d/])/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    let year = Number(match[1] || match[4] || base.year);
    const month = Number(match[2] || match[5] || match[7] || match[9]);
    const day = Number(match[3] || match[6] || match[8] || match[10]);
    if (!match[1] && !match[4]) {
      // Infer omitted years from receipt, not today's date. Handle December/January.
      if (month - base.month < -6) year++;
      else if (month - base.month > 6) year--;
    }
    const end = noticeDayEndExclusive_(year, month, day);
    if (end !== null) dates.push(end);
  }
  const relative = /明後日|明日|今日|本日/g;
  while ((match = relative.exec(text)) !== null) {
    const offset = match[0] === '明後日' ? 2 : match[0] === '明日' ? 1 : 0;
    dates.push(Date.UTC(base.year, base.month - 1, base.day + offset + 1) - 9 * 60 * 60 * 1000);
  }
  return dates.length ? Math.max(...dates) : null;
}

function isUniversityNoticeVisible_(row, referenceDate) {
  const now = referenceDate || new Date();
  const received = parseNotificationReceivedDate_(row[9]);
  if (!received) return true; // Missing dates are not evidence that mail has expired.
  if (String(row[2]) === 'Google Classroom') {
    const expiry = getClassroomNoticeExpiry_(row[11], received);
    return expiry !== null ? now.getTime() < expiry
      : now.getTime() < received.getTime() + 14 * 24 * 60 * 60 * 1000;
  }
  if (String(row[2]) === 'inCampus') {
    const p = noticeJapanParts_(now);
    const monthStart = new Date(Date.UTC(p.year, p.month - 2, 1));
    const year = monthStart.getUTCFullYear(), month = monthStart.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const cutoff = Date.UTC(year, month, Math.min(p.day, lastDay), p.hour, p.minute, p.second, p.ms) - 9 * 60 * 60 * 1000;
    return received.getTime() > cutoff;
  }
  return false;
}

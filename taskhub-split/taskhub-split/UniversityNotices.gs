function getUniversityNoticesForWeb(forceRefresh) {
  return getUniversityNoticesForWebLocked_(Boolean(forceRefresh));
}

function getUniversityNoticePayloadForWeb(forceRefresh, userPropertiesSnapshot, preferFirstPaint) {
  const startedAt = Date.now();
  const propertiesStartedAt = Date.now();
  const properties = userPropertiesSnapshot || PropertiesService.getUserProperties().getProperties();
  if (preferFirstPaint === true && !forceRefresh) {
    const firstPaint = getFirstPaintPayloadForWeb_('university', properties);
    if (firstPaint) return firstPaint;
  }
  const propertiesMs = userPropertiesSnapshot ? 0 : Date.now() - propertiesStartedAt;
  const testMode = properties[TEST_CASE_MODE_PROPERTY] === 'true';
  const now = testMode ? getTestCaseReferenceNowFromProperties_(properties) : new Date();
  const cacheToken = getUniversityNoticeCacheKey_(properties, testMode, now);
  const dataStartedAt = Date.now();
  const listItems = getUniversityNoticeListItemsForWeb_(Boolean(forceRefresh), properties);
  const items = testMode ? listItems.map(toUniversityNoticeListItemForWeb_) : listItems;
  if (!testMode) {
    // A page may have captured its initial properties just before a background
    // sync begins replacing the prepared sheets. Verify the read generation
    // after the range read so a mixed/partial sheet snapshot is retried.
    const latestProperties = PropertiesService.getUserProperties().getProperties();
    const generationBeforeRead = String(properties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] || '');
    const generationAfterRead = String(latestProperties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] || '');
    if (!isNotificationDisplayDataCurrent_(latestProperties) || generationBeforeRead !== generationAfterRead) {
      throw new Error('大学通知表示データを更新中です。表示データの更新後に再試行します。');
    }
  }
  const dataMs = Date.now() - dataStartedAt;
  const clockStateStartedAt = Date.now();
  const testCaseClockState = getTestCaseClockStateForWeb(properties);
  Logger.log('TASKHUB_UNIVERSITY_PAYLOAD_TIMING ' + JSON.stringify({
    propertiesMs,
    dataMs,
    clockStateMs: Date.now() - clockStateStartedAt,
    totalMs: Date.now() - startedAt,
    itemCount: items.length,
    cacheTokenAvailable: Boolean(cacheToken)
  }));
  return {items, cacheToken, testCaseClockState};
}

function getUniversityNoticeListItemsForWeb_(forceRefresh, properties) {
  const testMode = properties[TEST_CASE_MODE_PROPERTY] === 'true';
  if (testMode) {
    // Test fixtures are projected against a user-selected virtual date in
    // memory. Keep that real processing path, while still returning only the
    // compact list projection to the browser.
    return getUniversityNoticesForWebLocked_(forceRefresh, properties);
  }

  if (!isNotificationDisplayDataCurrent_(properties)) {
    const message = isNotificationDisplayDataBuilding_(properties)
      ? '大学通知表示データを更新中です。表示データの更新後に再試行します。'
      : '同期時に作成する大学通知表示データが未準備です。更新を実行してください。';
    throw new Error(message);
  }
  const spreadsheet = getSpreadsheetForRead_(properties);
  const items = getMaterializedUniversityNoticeListForWeb_(spreadsheet, properties, properties);
  if (items === null) {
    const message = isNotificationDisplayDataBuilding_(PropertiesService.getUserProperties().getProperties())
      ? '大学通知表示データを更新中です。表示データの更新後に再試行します。'
      : '大学通知の表示用シートを読み取れません。同期を再実行してください。';
    throw new Error(message);
  }
  Logger.log('TASKHUB_UNIVERSITY_NOTICE_LIST_READ ' + JSON.stringify({
    mode: 'prepared-list-only', itemCount: items.length, bodyColumnRead: false
  }));
  return items;
}

function toUniversityNoticeListItemForWeb_(item) {
  const preview = String(item && item.preview !== undefined
    ? item.preview
    : createUniversityNoticePreview_(item && item.body));
  return {
    messageId: String(item && item.messageId || ''),
    source: String(item && item.source || ''),
    title: String(item && item.title || ''),
    courseName: String(item && item.courseName || ''),
    from: String(item && item.from || ''),
    receivedAt: String(item && item.receivedAt || ''),
    receivedAtTime: Number(item && item.receivedAtTime || 0),
    gmailLink: String(item && item.gmailLink || ''),
    preview,
    read: Boolean(item && item.read),
    saved: Boolean(item && item.saved)
  };
}

function getUniversityNoticeBodyForWeb(messageId) {
  const id = String(messageId || '');
  if (!id || id.length > 200) return {found: false, messageId: id, body: ''};
  const properties = PropertiesService.getUserProperties().getProperties();
  const testMode = properties[TEST_CASE_MODE_PROPERTY] === 'true';
  if (testMode) {
    const items = getUniversityNoticesForWebLocked_(true, properties);
    const item = items.find(notice => String(notice.messageId || '') === id);
    return {found: Boolean(item), messageId: id, body: item ? String(item.body || '') : ''};
  }

  if (!isNotificationDisplayDataCurrent_(properties)) return {found: false, messageId: id, body: ''};
  // Full-body cache entries can be large. Selection needs only one body cell,
  // so avoid parsing/decompressing the entire search cache for every click.
  const spreadsheet = getSpreadsheetForRead_(properties);
  const sheet = spreadsheet && spreadsheet.getSheetByName(UNIVERSITY_NOTICE_DISPLAY_SHEET_NAME);
  if (!sheet) return {found: false, messageId: id, body: ''};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {found: false, messageId: id, body: ''};
  const headers = sheet.getRange(1, 1, 1, UNIVERSITY_NOTICE_DISPLAY_HEADERS.length).getValues()[0] || [];
  if (!UNIVERSITY_NOTICE_DISPLAY_HEADERS.every((value, index) => headers[index] === value)) {
    return {found: false, messageId: id, body: ''};
  }
  const idColumn = UNIVERSITY_NOTICE_DISPLAY_FIELDS.indexOf('messageId') + 1;
  const ids = sheet.getRange(2, idColumn, lastRow - 1, 1).getValues();
  const rowIndex = ids.findIndex(row => String(row[0] || '') === id);
  if (rowIndex < 0) return {found: false, messageId: id, body: ''};
  const bodyColumn = UNIVERSITY_NOTICE_DISPLAY_FIELDS.indexOf('body') + 1;
  const body = sheet.getRange(rowIndex + 2, bodyColumn, 1, 1).getValues()[0][0];
  return {found: true, messageId: id, body: String(body || '')};
}

function searchUniversityNoticesForWeb(query) {
  const normalizedQuery = String(query || '').normalize('NFKC').trim().toLowerCase();
  if (!normalizedQuery) return {query: '', messageIds: []};
  if (normalizedQuery.length > 200) throw new Error('検索語が長すぎます。');
  const result = getUniversityNoticeDetailsForDeferredWebRead_();
  const messageIds = result.items.filter(item => [item.title, item.body, item.from, item.source]
    .map(value => String(value || '').normalize('NFKC').toLowerCase())
    .some(value => value.includes(normalizedQuery)))
    .map(item => String(item.messageId || ''))
    .filter(Boolean);
  return {query: normalizedQuery, messageIds};
}

function getUniversityNoticeDetailsForDeferredWebRead_() {
  const properties = PropertiesService.getUserProperties().getProperties();
  const testMode = properties[TEST_CASE_MODE_PROPERTY] === 'true';
  const now = testMode ? getTestCaseReferenceNowFromProperties_(properties) : new Date();
  const cacheToken = getUniversityNoticeCacheKey_(properties, testMode, now);
  const cached = readUniversityNoticeCache_(properties, testMode, now);
  if (cached) return {items: cached.items, cacheToken};

  // Detail/search data is loaded only after the list has rendered. Cache full
  // rows for repeated searches; individual selections read only one body cell.
  const items = getUniversityNoticesForWebLocked_(true, properties);
  const latestProperties = PropertiesService.getUserProperties().getProperties();
  const latestTestMode = latestProperties[TEST_CASE_MODE_PROPERTY] === 'true';
  const latestNow = latestTestMode ? getTestCaseReferenceNowFromProperties_(latestProperties) : new Date();
  const latestCacheToken = getUniversityNoticeCacheKey_(latestProperties, latestTestMode, latestNow);
  if (cacheToken === latestCacheToken) writeUniversityNoticeCache_(cacheToken, items);
  return {items, cacheToken};
}

function cacheUniversityNoticeItemsAfterWebDisplay(items, cacheToken) {
  if (!Array.isArray(items) || items.length > 2000) return false;
  // Older clients may still send the full list. Reject compact list projections
  // so they cannot overwrite the server cache that supplies body search/details.
  if (items.some(item => !item || typeof item.messageId !== 'string' || !item.messageId || typeof item.body !== 'string')) return false;
  const properties = PropertiesService.getUserProperties().getProperties();
  const testMode = properties[TEST_CASE_MODE_PROPERTY] === 'true';
  const now = testMode ? getTestCaseReferenceNow_() : new Date();
  if (!testMode && properties[NOTIFICATION_DISPLAY_DATA_REVISION_PROPERTY] !== NOTIFICATION_DISPLAY_DATA_REVISION) return false;
  if (!testMode && isNotificationDisplayDataBuilding_(properties)) return false;
  if (String(cacheToken || '') !== getUniversityNoticeCacheKey_(properties, testMode, now)) return false;
  return writeUniversityNoticeCache_(String(cacheToken), items);
}

function getUniversityNoticesForWebLocked_(forceRefresh, userPropertiesSnapshot) {
  const startedAt = Date.now();
  const properties = userPropertiesSnapshot || PropertiesService.getUserProperties().getProperties();
  const testMode = properties[TEST_CASE_MODE_PROPERTY] === 'true';
  const now = testMode ? getTestCaseReferenceNowFromProperties_(properties) : new Date();

  if (!forceRefresh) {
    const cacheStartedAt = Date.now();
    const cached = readUniversityNoticeCache_(properties, testMode, now);
    if (cached) {
      Logger.log('TASKHUB_UNIVERSITY_NOTICE_READ_TIMING ' + JSON.stringify({
        mode: testMode ? 'test-cache-hit' : 'cache-hit',
        cacheReadMs: Date.now() - cacheStartedAt,
        totalMs: Date.now() - startedAt,
        itemCounts: {returned: cached.items.length},
        spreadsheetRead: false
      }));
      return cached.items;
    }
  }

  const testSpreadsheet = testMode ? openTestCaseSpreadsheet_() : null;
  const testDateContext = testMode ? getTestCaseDateContext_(testSpreadsheet, now) : null;
  const testStates = testMode ? getTestNotificationStateMap_(properties) : null;
  const states = properties;
  if (!testMode) {
    const displayStartedAt = Date.now();
    const spreadsheet = getSpreadsheetForRead_(properties);
    const spreadsheetOpenMs = Date.now() - displayStartedAt;
    const readStartedAt = Date.now();
    const displayItems = getMaterializedUniversityNoticesForWeb_(spreadsheet, now, states, properties);
    if (displayItems !== null) {
      Logger.log('TASKHUB_UNIVERSITY_NOTICE_READ_TIMING ' + JSON.stringify({
        mode: 'personal-display-data',
        spreadsheetOpenMs,
        displaySheetReadAndStateOverlayMs: Date.now() - readStartedAt,
        totalDisplayReadMs: Date.now() - displayStartedAt,
        totalMs: Date.now() - startedAt,
        itemCounts: {returned: displayItems.length},
        rawNotificationSheetsRead: false,
        classroomApiAssignmentsRead: false
      }));
      return displayItems;
    }
    throw new Error('同期時に作成する大学通知表示データが未準備です。更新を実行してください。');
  }
  const readContext = createNotificationReadContext_(testSpreadsheet, true);
  const contextReadyAt = Date.now();

  const noticeRows = getNotificationRowsFromSheets_(
    readContext.sheetsBySource,
    testMode,
    testDateContext,
    readContext,
    {
      includeClassroomApi: false,
      mergeClassroomApiAssignments: false,
      preprocessTestRows: testMode
    }
  );
  const rowsReadyAt = Date.now();
  const noticeItems = noticeRows
    .filter(row => isUniversityNoticeRow_(row))
    .map(row => {
      const notice = rowToUniversityNotice_(row);
      notice.expiresAtTime = getUniversityNoticeExpiryTimeForDisplay_(row);
      notice.originalMessageIdForState = String(row.originalMessageIdForState || '');
      return notice;
    });
  const noticesReadyAt = Date.now();
  const extractedItems = getInCampusSupplementItemsForWeb_(testSpreadsheet, testStates, testDateContext, readContext);
  const extractedReadyAt = Date.now();
  const preparedItems = buildUniversityNoticeDisplayItems_(noticeItems, extractedItems, testMode);
  const result = applyUniversityNoticeStateAndExpiryForWeb_(preparedItems, now, states, testMode);
  Logger.log('TASKHUB_UNIVERSITY_NOTICE_READ_TIMING ' + JSON.stringify({
    mode: testMode ? 'test-fixture-materialized' : 'personal-raw-fallback',
    contextMs: contextReadyAt - startedAt,
    sourceRowsMs: rowsReadyAt - contextReadyAt,
    noticeFilterAndMappingMs: noticesReadyAt - rowsReadyAt,
    inCampusExtractMappingMs: extractedReadyAt - noticesReadyAt,
    mergeMs: Date.now() - extractedReadyAt,
    totalMs: Date.now() - startedAt,
    sheetReadMs: readContext.sheetReadMs,
    sheetRowCounts: readContext.sheetRowCounts,
    itemCounts: {sourceRows: noticeRows.length, notices: noticeItems.length, inCampusExtracts: extractedItems.length, returned: result.length},
    classroomApiAssignmentsRead: false
  }));
  return result;
}

function applyUniversityNoticeStateAndExpiryForWeb_(items, referenceNow, states, testMode) {
  const statePrefix = getUniversityNoticeStatePrefix_(testMode);
  const stateMap = states || {};
  return filterUniversityNoticeDisplayItemsForNow_(items, referenceNow).map(item => {
    let state = {};
    const storedState = stateMap[statePrefix + item.messageId] ||
      (item.originalMessageIdForState ? stateMap[statePrefix + item.originalMessageIdForState] : '') || '{}';
    try { state = JSON.parse(storedState); } catch (_) {}
    return Object.assign({}, item, {read: Boolean(state.read), saved: Boolean(state.saved)});
  });
}

function isUniversityNoticeRow_(row) {
  const processed = getNotificationProcessedData_(row);
  if (processed) return Boolean(processed.isUniversityNotice);
  return isUniversityNoticeRowLegacy_(row);
}

function isUniversityNoticeRowLegacy_(row) {
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
  const processed = getNotificationProcessedData_(row);

  return {
    messageId: String(row[1] || ''),
    source,
    title: processed ? String(processed.displayTitle || processed.title || '') :
      source === 'inCampus' ? extractInCampusTitle_(row[7], row[11]) : String(row[7] || row[4] || ''),
    courseName: String(row[3] || ''),
    from: String(row[8] || ''),
    receivedAt: formatDateForWeb_(row[9]),
    receivedAtTime: getTimeForSort_(row[9]),
    gmailLink: String(row[10] || ''),
    body: processed ? String(processed.displayBody || '') : cleanBodyForWeb_(row[11], source)
  };
}

function setUniversityNoticeState(messageId, state) {
  return runWithUserLock_('大学のお知らせ', () => setUniversityNoticeStateLocked_(messageId, state));
}

function setUniversityNoticeStateLocked_(messageId, state) {
  if (typeof messageId !== 'string' || !messageId || messageId.length > 200 || !state || typeof state.read !== 'boolean' || typeof state.saved !== 'boolean') throw new Error('Invalid notice state');
  const props = PropertiesService.getUserProperties();
  props.setProperty(getUniversityNoticeStatePrefix_() + messageId, JSON.stringify({read: state.read, saved: state.saved}));
  const previousGeneration = Number(props.getProperty(UNIVERSITY_NOTICE_STATE_GENERATION_PROPERTY) || 0);
  props.setProperty(UNIVERSITY_NOTICE_STATE_GENERATION_PROPERTY,
    String(Number.isFinite(previousGeneration) ? previousGeneration + 1 : 1));
  return true;
}

function getUniversityNoticeStatePrefix_(testMode) {
  const useTestMode = typeof testMode === 'boolean' ? testMode : isTestCaseModeEnabled_();
  return useTestMode ? 'universityNotice:test:' : 'universityNotice:';
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
  const processed = getNotificationProcessedData_(row);
  if (processed && Object.prototype.hasOwnProperty.call(processed, 'expiresAt')) {
    return processed.expiresAt === null || now.getTime() < Number(processed.expiresAt);
  }
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

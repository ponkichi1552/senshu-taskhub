/** Create and migrate the single physical inCampus notification/extraction tab. */
const INCAMPUS_RECORD_MARKER_CHECK_PROPERTY = 'TASKHUB_INCAMPUS_RECORD_MARKER_CHECK';
const INCAMPUS_LEGACY_MIGRATION_CHECK_PROPERTY = 'TASKHUB_INCAMPUS_LEGACY_MIGRATION_CHECK';

function getOrCreateInCampusUnifiedSheetLocked_(spreadsheet) {
  const ss = spreadsheet || getTargetSpreadsheet_();
  let sheet = ss.getSheetByName(INCAMPUS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(INCAMPUS_SHEET_NAME);
  setupInCampusUnifiedHeader_(sheet, ss);
  const properties = PropertiesService.getUserProperties();
  const migrationKey = getInCampusSchemaCheckKey_(ss, sheet, 'legacy-v1');
  const spreadsheetId = String(ss.getId ? ss.getId() : 'default');
  const legacyMigration = properties.getProperty(LEGACY_INCAMPUS_EXTRACT_MIGRATION_PROPERTY);
  if (properties.getProperty(INCAMPUS_LEGACY_MIGRATION_CHECK_PROPERTY) !== migrationKey && legacyMigration !== spreadsheetId) {
    migrateLegacyInCampusExtractionLocked_(ss, sheet);
    properties.setProperty(INCAMPUS_LEGACY_MIGRATION_CHECK_PROPERTY, migrationKey);
  }
  return sheet;
}

function setupInCampusUnifiedHeader_(sheet, spreadsheet) {
  const width = Math.max(sheet.getLastColumn(), INCAMPUS_UNIFIED_HEADERS.length);
  const currentHeader = sheet.getRange(1, 1, 1, width).getValues()[0];
  const isUnified = INCAMPUS_UNIFIED_HEADERS.every((header, index) => currentHeader[index] === header);
  if (isUnified) {
    ensureInCampusRecordTypeMarkers_(sheet, width, spreadsheet);
    return;
  }

  const hasContent = currentHeader.some(value => String(value || '').trim()) || sheet.getLastRow() >= 2;
  const isMailTable = HEADER_ROW.every((header, index) => currentHeader[index] === header) || isLegacyNotificationMailHeader_(currentHeader);
  const isExtractTable = INCAMPUS_HEADERS.every((header, index) => currentHeader[index] === header);
  if (hasContent && !isMailTable && !isExtractTable) {
    throw new Error('inCampus通知シートの既存見出しを判別できないため、統合を中止しました。');
  }

  const oldRows = sheet.getLastRow() >= 2
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues()
    : [];
  const knownWidth = isMailTable ? HEADER_ROW.length : isExtractTable ? INCAMPUS_HEADERS.length : 0;
  const hasUnknownTrailingData = knownWidth > 0 && (
    currentHeader.slice(knownWidth).some(value => String(value || '').trim()) ||
    oldRows.some(row => row.slice(knownWidth).some(value => value !== '' && value !== null && value !== undefined))
  );
  if (hasUnknownTrailingData) {
    throw new Error('inCampus通知シートに未対応の列またはデータがあるため、統合を中止しました。元データを保護しています。');
  }
  const unifiedRows = oldRows.map(row => {
    const target = Array(INCAMPUS_UNIFIED_HEADERS.length).fill('');
    if (isMailTable) {
      HEADER_ROW.forEach((_, index) => { target[index] = row[index] === undefined ? '' : row[index]; });
      if (String(row[2] || '') === 'inCampus' && String(row[1] || '')) {
        target[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] = INCAMPUS_GMAIL_RECORD_TYPE;
      }
    } else if (isExtractTable && row.some(value => value !== '' && value !== null && value !== undefined)) {
      INCAMPUS_HEADERS.forEach((_, index) => {
        target[INCAMPUS_UNIFIED_EXTRACT_START_COLUMN + index] = row[index] === undefined ? '' : row[index];
      });
      target[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] = INCAMPUS_EXTRACT_RECORD_TYPE;
    }
    return target;
  });

  sheet.getRange(1, 1, 1, INCAMPUS_UNIFIED_HEADERS.length).setValues([INCAMPUS_UNIFIED_HEADERS]);
  if (unifiedRows.length) {
    sheet.getRange(2, 1, unifiedRows.length, INCAMPUS_UNIFIED_HEADERS.length).setValues(unifiedRows);
  }
  sheet.setFrozenRows(1);
  ensureInCampusRecordTypeMarkers_(sheet, Math.max(width, INCAMPUS_UNIFIED_HEADERS.length), spreadsheet);
}

function isLegacyNotificationMailHeader_(header) {
  return HEADER_ROW.length === 16 && header[15] === '適用済み提出記録' &&
    HEADER_ROW.slice(0, 15).every((name, index) => header[index] === name);
}

function ensureInCampusRecordTypeMarkers_(sheet, width, spreadsheet) {
  const properties = PropertiesService.getUserProperties();
  const markerKey = getInCampusSchemaCheckKey_(spreadsheet, sheet, 'markers-v1');
  if (properties.getProperty(INCAMPUS_RECORD_MARKER_CHECK_PROPERTY) === markerKey) return;
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, Math.max(width, INCAMPUS_UNIFIED_HEADERS.length)).getValues();
    let changed = false;
    values.forEach(row => {
      const typeIndex = INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN;
      if (row[typeIndex]) return;
      if (String(row[2] || '') === 'inCampus') {
        row[typeIndex] = INCAMPUS_GMAIL_RECORD_TYPE;
        changed = true;
      } else if (row.slice(INCAMPUS_UNIFIED_EXTRACT_START_COLUMN).some(value => value !== '' && value !== null && value !== undefined)) {
        row[typeIndex] = INCAMPUS_EXTRACT_RECORD_TYPE;
        changed = true;
      }
    });
    if (changed) {
      sheet.getRange(2, 1, values.length, Math.max(width, INCAMPUS_UNIFIED_HEADERS.length)).setValues(values);
    }
  }
  properties.setProperty(INCAMPUS_RECORD_MARKER_CHECK_PROPERTY, markerKey);
}

function getInCampusSchemaCheckKey_(spreadsheet, sheet, revision) {
  let workbook = spreadsheet;
  if (!workbook && sheet && typeof sheet.getParent === 'function') workbook = sheet.getParent();
  let spreadsheetId = workbook && workbook.getId ? workbook.getId() : '';
  if (!spreadsheetId) {
    const properties = PropertiesService.getUserProperties();
    spreadsheetId = properties.getProperty(USER_SPREADSHEET_ID_PROPERTY) || '';
  }
  const sheetId = sheet && sheet.getSheetId ? sheet.getSheetId() : '';
  return `${spreadsheetId || 'current-user'}:${sheetId}:${revision}`;
}

function migrateLegacyInCampusExtractionLocked_(spreadsheet, destinationSheet) {
  const ss = spreadsheet || getTargetSpreadsheet_();
  const oldSheet = ss.getSheetByName('inCampus抽出');
  if (!oldSheet) return 0;

  const oldValues = oldSheet.getLastRow() >= 1
    ? oldSheet.getDataRange().getValues()
    : [];
  const oldHeader = (oldValues[0] || []).map(value => String(value || '').trim());
  if (!oldHeader.some(Boolean) && oldValues.slice(1).every(row => row.every(value => value === '' || value === null || value === undefined))) {
    if (typeof ss.deleteSheet === 'function') ss.deleteSheet(oldSheet);
    return 0;
  }
  const oldHeaderMap = new Map(oldHeader.map((name, index) => [name, index]));
  const missingHeaders = INCAMPUS_HEADERS.filter(header => !oldHeaderMap.has(header));
  if (missingHeaders.length) {
    throw new Error(`inCampus抽出の移行を中止しました。必要な列がありません: ${missingHeaders.join(', ')}`);
  }

  const extractColumnStart = INCAMPUS_UNIFIED_EXTRACT_START_COLUMN;
  const oldRecords = oldValues.slice(1).filter(row =>
    INCAMPUS_HEADERS.some(header => {
      const value = row[oldHeaderMap.get(header)];
      return value !== '' && value !== null && value !== undefined;
    })
  );
  const toSignature = row => INCAMPUS_HEADERS.map(header => {
    const value = row[oldHeaderMap.get(header)];
    if (value instanceof Date && !Number.isNaN(value.getTime())) return `date:${value.toISOString()}`;
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }).join('\u001f');

  const existingRows = destinationSheet.getLastRow() >= 2
    ? destinationSheet.getRange(2, 1, destinationSheet.getLastRow() - 1, INCAMPUS_UNIFIED_HEADERS.length).getValues()
    : [];
  const existingCounts = new Map();
  existingRows.filter(row => String(row[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] || '') === INCAMPUS_EXTRACT_RECORD_TYPE)
    .forEach(row => {
      const signature = INCAMPUS_HEADERS.map((_, index) => {
        const value = row[extractColumnStart + index];
        if (value instanceof Date && !Number.isNaN(value.getTime())) return `date:${value.toISOString()}`;
        if (value === null || value === undefined) return '';
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
      }).join('\u001f');
      existingCounts.set(signature, (existingCounts.get(signature) || 0) + 1);
    });

  const rowsToAppend = [];
  oldRecords.forEach(oldRow => {
    const signature = toSignature(oldRow);
    const available = existingCounts.get(signature) || 0;
    if (available > 0) {
      existingCounts.set(signature, available - 1);
      return;
    }
    const target = Array(INCAMPUS_UNIFIED_HEADERS.length).fill('');
    target[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] = INCAMPUS_EXTRACT_RECORD_TYPE;
    INCAMPUS_HEADERS.forEach((header, index) => {
      target[extractColumnStart + index] = oldRow[oldHeaderMap.get(header)] === undefined
        ? '' : oldRow[oldHeaderMap.get(header)];
    });
    rowsToAppend.push(target);
  });

  if (rowsToAppend.length) {
    const startRow = destinationSheet.getLastRow() + 1;
    destinationSheet.getRange(startRow, 1, rowsToAppend.length, INCAMPUS_UNIFIED_HEADERS.length).setValues(rowsToAppend);
  }

  const copiedRows = destinationSheet.getLastRow() >= 2
    ? destinationSheet.getRange(2, 1, destinationSheet.getLastRow() - 1, INCAMPUS_UNIFIED_HEADERS.length).getValues()
      .filter(row => String(row[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] || '') === INCAMPUS_EXTRACT_RECORD_TYPE)
    : [];
  const copiedCounts = new Map();
  copiedRows.forEach(row => {
    const signature = INCAMPUS_HEADERS.map((_, index) => {
      const value = row[extractColumnStart + index];
      if (value instanceof Date && !Number.isNaN(value.getTime())) return `date:${value.toISOString()}`;
      if (value === null || value === undefined) return '';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }).join('\u001f');
    copiedCounts.set(signature, (copiedCounts.get(signature) || 0) + 1);
  });
  const verified = oldRecords.every(row => {
    const signature = toSignature(row);
    const count = copiedCounts.get(signature) || 0;
    if (!count) return false;
    copiedCounts.set(signature, count - 1);
    return true;
  });
  if (!verified) throw new Error('inCampus抽出の移行後検証に失敗したため、元シートを残しました。');

  const extraDataExists = oldValues.slice(1).some(row =>
    row.slice(INCAMPUS_HEADERS.length).some(value => value !== '' && value !== null && value !== undefined)
  ) || oldHeader.slice(INCAMPUS_HEADERS.length).some(value => value);
  if (!extraDataExists && typeof ss.deleteSheet === 'function') {
    ss.deleteSheet(oldSheet);
  }
  PropertiesService.getUserProperties().setProperty(
    LEGACY_INCAMPUS_EXTRACT_MIGRATION_PROPERTY,
    String(ss.getId ? ss.getId() : 'default')
  );
  return rowsToAppend.length;
}

/** Expose only extraction records to the existing inCampus parser/writer code. */
function createInCampusExtractSheetAdapter_(unifiedSheet) {
  const getHeader = () => INCAMPUS_HEADERS.slice();
  let lastReadRecords = null;
  let lastReadPhysicalRows = null;

  function getRecordsSafely_() {
    if (!unifiedSheet || unifiedSheet.getLastRow() < 2) {
      lastReadPhysicalRows = [];
      return [];
    }
    const values = unifiedSheet.getRange(2, 1, unifiedSheet.getLastRow() - 1, INCAMPUS_UNIFIED_HEADERS.length).getValues();
    lastReadPhysicalRows = values;
    return values.map((row, index) => ({
      physicalRow: index + 2,
      values: row.slice(INCAMPUS_UNIFIED_EXTRACT_START_COLUMN, INCAMPUS_UNIFIED_EXTRACT_START_COLUMN + INCAMPUS_HEADERS.length),
      recordType: String(row[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] || '')
    })).filter(record => record.recordType === INCAMPUS_EXTRACT_RECORD_TYPE);
  }

  function rangeValues_(row, column, rowCount, columnCount) {
    const records = getRecordsSafely_();
    return Array.from({length: rowCount}, (_, rowOffset) => {
      const logicalRow = row + rowOffset;
      if (logicalRow === 1) return INCAMPUS_HEADERS.slice(column - 1, column - 1 + columnCount);
      const record = records[logicalRow - 2];
      return record ? record.values.slice(column - 1, column - 1 + columnCount) : Array(columnCount).fill('');
    });
  }

  function writeRange_(row, column, values) {
    updateExtractedRanges_(values.map((sourceRow, rowOffset) => ({
      row: row + rowOffset,
      column,
      values: sourceRow
    })));
  }

  function updateExtractedRanges_(updates) {
    const records = lastReadRecords || getRecordsSafely_();
    if (!updates.length) return;
    const mapped = updates.map(update => {
      if (update.row < 2) throw new Error('inCampus抽出の見出しは変更できません。');
      const record = records[update.row - 2];
      if (!record) throw new Error('更新対象のinCampus抽出行が見つかりません。');
      return {record, column: update.column, values: update.values};
    });
    const firstPhysicalRow = Math.min(...mapped.map(update => update.record.physicalRow));
    const lastPhysicalRow = Math.max(...mapped.map(update => update.record.physicalRow));
    const firstColumn = Math.min(...mapped.map(update => update.column));
    const lastColumn = Math.max(...mapped.map(update => update.column + update.values.length - 1));
    const rowCount = lastPhysicalRow - firstPhysicalRow + 1;
    const columnCount = lastColumn - firstColumn + 1;
    const startColumnOffset = INCAMPUS_UNIFIED_EXTRACT_START_COLUMN + firstColumn - 1;
    const values = Array.from({length: rowCount}, (_, rowOffset) => {
      const physicalRow = firstPhysicalRow + rowOffset;
      const physicalValues = lastReadPhysicalRows[physicalRow - 2] || [];
      return Array.from({length: columnCount}, (_, columnOffset) => {
        const value = physicalValues[startColumnOffset + columnOffset];
        return value === undefined ? '' : value;
      });
    });
    mapped.forEach(update => {
      const rowOffset = update.record.physicalRow - firstPhysicalRow;
      const columnOffset = update.column - firstColumn;
      update.values.forEach((value, index) => { values[rowOffset][columnOffset + index] = value; });
    });
    unifiedSheet.getRange(firstPhysicalRow, INCAMPUS_UNIFIED_EXTRACT_START_COLUMN + firstColumn,
      rowCount, columnCount).setValues(values);
    values.forEach((row, rowOffset) => {
      const physicalValues = lastReadPhysicalRows[firstPhysicalRow - 2 + rowOffset];
      row.forEach((value, columnOffset) => {
        physicalValues[startColumnOffset + columnOffset] = value;
      });
    });
    lastReadRecords = null;
  }

  function appendRows_(rows) {
    if (!rows.length) return;
    const unifiedRows = rows.map(values => {
      const row = Array(INCAMPUS_UNIFIED_HEADERS.length).fill('');
      row[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] = INCAMPUS_EXTRACT_RECORD_TYPE;
      INCAMPUS_HEADERS.forEach((_, index) => {
        row[INCAMPUS_UNIFIED_EXTRACT_START_COLUMN + index] = values[index] === undefined ? '' : values[index];
      });
      return row;
    });
    const startRow = unifiedSheet.getLastRow() + 1;
    unifiedSheet.getRange(startRow, 1, unifiedRows.length, INCAMPUS_UNIFIED_HEADERS.length).setValues(unifiedRows);
    lastReadRecords = null;
    lastReadPhysicalRows = null;
  }

  function makeRange_(row, column, rowCount, columnCount) {
    return {
      getValues() { return rangeValues_(row, column, rowCount, columnCount); },
      setValues(values) { writeRange_(row, column, values); return this; },
      setValue(value) { writeRange_(row, column, [[value]]); return this; },
      clearContent() { writeRange_(row, column, Array.from({length: rowCount}, () => Array(columnCount).fill(''))); return this; },
      setNumberFormat() { return this; },
      setFontWeight() { return this; }
    };
  }

  return {
    __inCampusExtractAdapter: true,
    getName() { return INCAMPUS_SHEET_NAME; },
    getLastRow() { return getRecordsSafely_().length + 1; },
    getLastColumn() { return INCAMPUS_HEADERS.length; },
    getFrozenRows() { return 1; },
    setFrozenRows() {},
    getDataRange() {
      lastReadRecords = getRecordsSafely_();
      const values = [getHeader()].concat(lastReadRecords.map(record => record.values));
      return {getValues() { return values.map(row => row.slice()); }};
    },
    getUnifiedRowsSnapshot() {
      if (!Array.isArray(lastReadPhysicalRows) || unifiedSheet.getLastRow() !== lastReadPhysicalRows.length + 1) {
        getRecordsSafely_();
      }
      return [INCAMPUS_UNIFIED_HEADERS.slice()].concat(lastReadPhysicalRows.map(row => row.slice()));
    },
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return makeRange_(row, column, rowCount, columnCount);
    },
    appendRow(values) {
      appendRows_([values]);
      return this;
    },
    appendRows(values) {
      appendRows_(values);
      return this;
    },
    updateRows(updates) {
      updateExtractedRanges_(updates.map(update => ({row: update.row, column: 1, values: update.values})));
      return this;
    }
  };
}

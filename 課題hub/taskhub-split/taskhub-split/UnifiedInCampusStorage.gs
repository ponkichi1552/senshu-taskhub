/** Create and migrate the single physical inCampus notification/extraction tab. */
function getOrCreateInCampusUnifiedSheetLocked_(spreadsheet) {
  const ss = spreadsheet || getTargetSpreadsheet_();
  let sheet = ss.getSheetByName(INCAMPUS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(INCAMPUS_SHEET_NAME);
  setupInCampusUnifiedHeader_(sheet);
  migrateLegacyInCampusExtractionLocked_(ss, sheet);
  return sheet;
}

function setupInCampusUnifiedHeader_(sheet) {
  const width = Math.max(sheet.getLastColumn(), INCAMPUS_UNIFIED_HEADERS.length);
  const currentHeader = sheet.getRange(1, 1, 1, width).getValues()[0];
  const isUnified = INCAMPUS_UNIFIED_HEADERS.every((header, index) => currentHeader[index] === header);
  if (isUnified) {
    ensureInCampusRecordTypeMarkers_(sheet, width);
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
  ensureInCampusRecordTypeMarkers_(sheet, Math.max(width, INCAMPUS_UNIFIED_HEADERS.length));
}

function isLegacyNotificationMailHeader_(header) {
  return HEADER_ROW.length === 16 && header[15] === '適用済み提出記録' &&
    HEADER_ROW.slice(0, 15).every((name, index) => header[index] === name);
}

function ensureInCampusRecordTypeMarkers_(sheet, width) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
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

  function getRecordsSafely_() {
    if (!unifiedSheet || unifiedSheet.getLastRow() < 2) return [];
    const values = unifiedSheet.getRange(2, 1, unifiedSheet.getLastRow() - 1, INCAMPUS_UNIFIED_HEADERS.length).getValues();
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
    const records = getRecordsSafely_();
    values.forEach((sourceRow, rowOffset) => {
      const logicalRow = row + rowOffset;
      if (logicalRow < 2) throw new Error('inCampus抽出の見出しは変更できません。');
      const record = records[logicalRow - 2];
      if (!record) throw new Error('更新対象のinCampus抽出行が見つかりません。');
      unifiedSheet.getRange(record.physicalRow, INCAMPUS_UNIFIED_EXTRACT_START_COLUMN + column, 1, sourceRow.length)
        .setValues([sourceRow]);
    });
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
      const values = [getHeader()].concat(getRecordsSafely_().map(record => record.values));
      return {getValues() { return values.map(row => row.slice()); }};
    },
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return makeRange_(row, column, rowCount, columnCount);
    },
    appendRow(values) {
      const row = Array(INCAMPUS_UNIFIED_HEADERS.length).fill('');
      row[INCAMPUS_UNIFIED_RECORD_TYPE_COLUMN] = INCAMPUS_EXTRACT_RECORD_TYPE;
      INCAMPUS_HEADERS.forEach((_, index) => { row[INCAMPUS_UNIFIED_EXTRACT_START_COLUMN + index] = values[index] === undefined ? '' : values[index]; });
      const targetRow = unifiedSheet.getLastRow() + 1;
      unifiedSheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
      return this;
    }
  };
}

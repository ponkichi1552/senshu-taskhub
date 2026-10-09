// Durable, unfiltered Classroom display inputs prepared by Gmail/API sync.
// Extension saves can reproject deadlines without rereading Classroom Sheets.
const CLASSROOM_DISPLAY_INPUT_MANIFEST_PROPERTY = 'TASKHUB_CLASSROOM_DISPLAY_INPUT_MANIFEST';
const CLASSROOM_DISPLAY_INPUT_CHUNK_PREFIX = 'TASKHUB_CLASSROOM_DISPLAY_INPUT_CHUNK_';
const CLASSROOM_DISPLAY_INPUT_REVISION = '2026-10-09-v1';
const CLASSROOM_DISPLAY_INPUT_MAX_LENGTH = 96000;

function invalidateClassroomDisplayInputs_() {
  PropertiesService.getUserProperties().deleteProperty(CLASSROOM_DISPLAY_INPUT_MANIFEST_PROPERTY);
}

function readClassroomDisplayInputsForExtension_(spreadsheet, properties) {
  if (!isNotificationDisplayDataCurrentForProperties_(properties) ||
      properties[CLASSROOM_API_STRUCTURED_SYNC_IN_PROGRESS_PROPERTY] === 'true') return null;
  try {
    const manifest = JSON.parse(properties[CLASSROOM_DISPLAY_INPUT_MANIFEST_PROPERTY] || 'null');
    if (!manifest || manifest.revision !== CLASSROOM_DISPLAY_INPUT_REVISION ||
        manifest.spreadsheetId !== spreadsheet.getId() ||
        manifest.displayGeneration !== properties[NOTIFICATION_DISPLAY_DATA_GENERATION_PROPERTY] ||
        manifest.statusGeneration !== String(properties[TASK_DISPLAY_STATUS_GENERATION_PROPERTY] || '0') ||
        !Number.isSafeInteger(manifest.encodedLength) || manifest.encodedLength < 1 ||
        manifest.encodedLength > CLASSROOM_DISPLAY_INPUT_MAX_LENGTH ||
        manifest.chunks !== Math.ceil(manifest.encodedLength / COMPLETE_DISPLAY_PROPERTY_CHUNK_LENGTH)) return null;
    const encoded = Array.from({length: manifest.chunks}, (_, index) =>
      properties[CLASSROOM_DISPLAY_INPUT_CHUNK_PREFIX + index] || '').join('');
    if (encoded.length !== manifest.encodedLength || completeDisplayDigest_(encoded) !== manifest.digest) return null;
    const data = JSON.parse(Utilities.ungzip(Utilities.newBlob(
      Utilities.base64Decode(encoded), 'application/gzip')).getDataAsString('UTF-8'));
    if (!data || !['tasks', 'notices'].every(key => Array.isArray(data[key]) &&
        data[key].every(item => item && item.source === 'Google Classroom' &&
          typeof item.messageId === 'string' && item.messageId))) return null;
    return data;
  } catch (_) { return null; }
}

function writeClassroomDisplayInputsAfterSync_(spreadsheet, inputs, displayGeneration, statusGeneration) {
  const props = PropertiesService.getUserProperties();
  try {
    const values = props.getProperties();
    const encoded = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(
      JSON.stringify(toNotificationWebSafeValue_(inputs)), 'application/json')).getBytes());
    const remainingBytes = Object.keys(values).reduce((total, key) =>
      key.startsWith(CLASSROOM_DISPLAY_INPUT_CHUNK_PREFIX) || key === CLASSROOM_DISPLAY_INPUT_MANIFEST_PROPERTY
        ? total : total + key.length + (key.startsWith(COMPLETE_DISPLAY_CHUNK_PREFIX)
          ? String(values[key]).length : String(values[key]).length * 3), 0);
    if (encoded.length > CLASSROOM_DISPLAY_INPUT_MAX_LENGTH ||
        remainingBytes + encoded.length + 2000 > COMPLETE_DISPLAY_PROPERTY_STORE_BUDGET) {
      invalidateClassroomDisplayInputs_();
      return false;
    }
    const manifest = {revision: CLASSROOM_DISPLAY_INPUT_REVISION, spreadsheetId: spreadsheet.getId(),
      displayGeneration, statusGeneration, encodedLength: encoded.length,
      chunks: Math.ceil(encoded.length / COMPLETE_DISPLAY_PROPERTY_CHUNK_LENGTH),
      digest: completeDisplayDigest_(encoded)};
    const updates = {};
    for (let index = 0; index < manifest.chunks; index++) {
      updates[CLASSROOM_DISPLAY_INPUT_CHUNK_PREFIX + index] = encoded.slice(
        index * COMPLETE_DISPLAY_PROPERTY_CHUNK_LENGTH, (index + 1) * COMPLETE_DISPLAY_PROPERTY_CHUNK_LENGTH);
    }
    updates[CLASSROOM_DISPLAY_INPUT_MANIFEST_PROPERTY] = JSON.stringify(manifest);
    if (typeof props.setProperties === 'function') props.setProperties(updates);
    else Object.keys(updates).forEach(key => props.setProperty(key, updates[key]));
    Object.keys(values).filter(key => key.startsWith(CLASSROOM_DISPLAY_INPUT_CHUNK_PREFIX) &&
      Number(key.slice(CLASSROOM_DISPLAY_INPUT_CHUNK_PREFIX.length)) >= manifest.chunks)
      .forEach(key => props.deleteProperty(key));
    return true;
  } catch (error) {
    invalidateClassroomDisplayInputs_();
    Logger.log('TASKHUB_CLASSROOM_DISPLAY_INPUT_FALLBACK ' + String(error && error.message || error));
    return false;
  }
}

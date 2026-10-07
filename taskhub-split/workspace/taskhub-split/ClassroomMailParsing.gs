function extractClassroomUrl_(source, body) {
  if (source !== 'Google Classroom') {
    return '';
  }

  const candidates = extractClassroomUrlCandidates_(body);
  const assignmentUrl = candidates.find(url => isClassroomAssignmentUrl_(url));

  return assignmentUrl || candidates[0] || '';
}

function extractClassroomUrlCandidates_(body) {
  const content = removeEmailFooterForUrlExtraction_(body);
  const lines = String(content || '')
    .split(/\r?\n/)
    .map(line => line.trim());
  const candidates = [];
  const seen = {};
  const addCandidate = value => {
    const normalizedUrl = normalizeClassroomUrlForMatch_(value);

    if (!normalizedUrl || seen[normalizedUrl]) {
      return;
    }

    seen[normalizedUrl] = true;
    candidates.push(normalizedUrl);
  };
  const markerTexts = [
    '詳細を表示',
    '課題を表示',
    '返信'
  ];

  for (const markerText of markerTexts) {
    const url = getClassroomUrlFromNextLine_(lines, markerText);

    if (url) {
      addCandidate(url);
    }
  }

  for (const line of lines) {
    addCandidate(extractClassroomUrlFromLine_(line));
  }

  return candidates;
}

function isClassroomAssignmentUrl_(value) {
  return /\/c\/[^/]+\/a\/[^/]+\/details$/.test(String(value || ''));
}

function removeEmailFooterForUrlExtraction_(body) {
  const text = String(body || '');
  const footerMarker = 'Google LLC 1600 Amphitheatre Parkway';
  const footerIndex = text.indexOf(footerMarker);

  if (footerIndex >= 0) {
    return text.slice(0, footerIndex);
  }

  return text;
}

function getClassroomUrlFromNextLine_(lines, markerText) {
  for (let i = 0; i < lines.length - 1; i++) {
    const currentLine = String(lines[i] || '').trim();

    if (currentLine === markerText || currentLine.includes(markerText)) {
      return extractClassroomUrlFromLine_(lines[i + 1]);
    }
  }

  return '';
}

function extractClassroomUrlFromLine_(line) {
  const text = String(line || '').trim();
  const decodedText = decodeUrlTextForClassroom_(text);

  if (!text.includes('classroom.google.com') && !decodedText.includes('classroom.google.com')) {
    return '';
  }

  const targetText = text.includes('classroom.google.com') ? text : decodedText;
  const angleMatch = targetText.match(/<([^<>]*classroom\.google\.com[^<>]*)>/);

  if (angleMatch) {
    return angleMatch[1].trim();
  }

  const bareMatch = targetText.match(/https?:\/\/[^\s<>]+/);

  if (!bareMatch) {
    return '';
  }

  const url = bareMatch[0]
    .replace(/[、。]+$/g, '')
    .trim();

  if (!url.includes('classroom.google.com')) {
    return '';
  }

  return url;
}

function decodeUrlTextForClassroom_(value) {
  let text = String(value || '');

  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(text);

      if (decoded === text) {
        return decoded;
      }

      text = decoded;
    } catch (error) {
      return text;
    }
  }

  return text;
}

function extractCourseName_(body) {
  const lines = getClassroomMeaningfulLines_(body);

  if (lines.length > 0 && !isClassroomNotificationMarker_(lines[0])) {
    return lines[0];
  }

  const markerIndex = getClassroomNotificationMarkerIndex_(lines);

  if (markerIndex > 0) {
    return lines[markerIndex - 1];
  }

  return '授業名未抽出';
}

function extractTitle_(subject, body) {
  const subjectText = String(subject || '');
  const subjectMatch = subjectText.match(/(?:新しい課題|新しいお知らせ|新しい資料)[:：]\s*[「"]?(.+?)[」"]?$/);

  if (subjectMatch) {
    return subjectMatch[1].trim();
  }

  const lines = getClassroomMeaningfulLines_(body);
  const markerIndex = getClassroomNotificationMarkerIndex_(lines);

  if (markerIndex >= 0) {
    const titleCandidate = lines
      .slice(markerIndex + 1)
      .find(line => {
        if (isClassroomNotificationMarker_(line)) {
          return false;
        }

        if (line.includes('先生が')) {
          return false;
        }

        return !isNoiseLine_(line);
      });

    if (titleCandidate) {
      return titleCandidate;
    }
  }

  for (const line of lines) {
    if (isNoiseLine_(line)) {
      continue;
    }

    if (line.includes('課題を表示') || line.includes('成績を表示')) {
      continue;
    }

    if (TASK_KEYWORDS.some(keyword => line.includes(keyword))) {
      return line;
    }
  }

  return 'タイトル未抽出';
}

function getCleanLines_(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
}

function isNoiseLine_(line) {
  const text = String(line || '').trim();

  if (text === '') {
    return true;
  }

  if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('<http')) {
    return true;
  }

  if (text.includes('accounts.google.com')) {
    return true;
  }

  if (text.includes('Google LLC')) {
    return true;
  }

  if (text.includes('このメールは、Google Classroom')) {
    return true;
  }

  if (text.includes('通知設定')) {
    return true;
  }

  return false;
}

function extractDueDate_(text, receivedDate) {
  const sourceText = String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:投稿日|投稿日時|送信日時|メール受信日時|通知日時)\s*[:：]/.test(line))
    .join('\n')
    .replace(/https?:\/\/[^\s<>]+/g, ' ');
  const monthDayYearResolver = createMonthDayYearResolver_(receivedDate);

  if (
    sourceText.includes('期限なし') ||
    sourceText.includes('締切なし') ||
    sourceText.includes('提出期限なし')
  ) {
    return {
      dueDate: '期限なし',
      dueStatus: '期限なし'
    };
  }

  let result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:期限|締切|提出期限|締め切り|しめきり)\s*[:：]?\s*(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  if (
    sourceText.includes('明日まで') ||
    sourceText.includes('明日締切') ||
    sourceText.includes('明日提出')
  ) {
    const due = new Date(receivedDate);
    due.setDate(due.getDate() + 1);

    return {
      dueDate: formatDateObject_(due),
      dueStatus: '相対日付抽出'
    };
  }

  const weekdayMatch = sourceText.match(/今週\s*(月曜|火曜|水曜|木曜|金曜|土曜|日曜|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日)まで/);

  if (weekdayMatch) {
    const due = getDateOfThisWeekday_(receivedDate, weekdayMatch[1]);

    return {
      dueDate: formatDateObject_(due),
      dueStatus: '相対日付抽出'
    };
  }

  result = findValidDueDate_(
    sourceText,
    /(?:^|[^\d/])(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?(?!\d|\/)/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:^|[^\d/])(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?(?!\d|\/)/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功'
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(\d{1,2})月\s*(\d{1,2})日(?:\s+(\d{1,2}:\d{2}))?/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  result = findValidDueDate_(
    sourceText,
    /(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?(?!\d|\/)/g,
    '抽出成功',
    monthDayYearResolver
  );
  if (result) return result;

  return {
    dueDate: '',
    dueStatus: '期限未検出・要確認'
  };
}

function findValidDueDate_(text, regex, status, fixedYear) {
  let match;

  while ((match = regex.exec(text)) !== null) {
    let year;
    let month;
    let day;
    let time;

    if (fixedYear) {
      year = typeof fixedYear === 'function'
        ? fixedYear(match[1], match[2])
        : fixedYear;
      month = match[1];
      day = match[2];
      time = match[3];
    } else {
      year = match[1];
      month = match[2];
      day = match[3];
      time = match[4];
    }

    const result = buildDueDateResult_(year, month, day, time, status);

    if (result) {
      return result;
    }
  }

  return null;
}

function buildDueDateResult_(year, month, day, timeText, status) {
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);

  if (!isValidDateParts_(yearNum, monthNum, dayNum)) {
    return null;
  }

  const time = normalizeTimeText_(timeText);

  return {
    dueDate: formatDueDate_(yearNum, monthNum, dayNum, time),
    dueStatus: status
  };
}

function formatDueDate_(year, month, day, time) {
  const y = String(year);
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');

  if (time) {
    return `${y}/${m}/${d} ${time}`;
  }

  return `${y}/${m}/${d}`;
}

function getYearFromDate_(date) {
  if (date instanceof Date) {
    return date.getFullYear();
  }

  return new Date().getFullYear();
}

function createMonthDayYearResolver_(receivedDate) {
  const base = receivedDate instanceof Date
    ? new Date(receivedDate)
    : new Date();

  base.setHours(0, 0, 0, 0);

  return (month, day) => {
    const baseYear = base.getFullYear();
    const monthNum = Number(month);
    const dayNum = Number(day);

    if (!isValidDateParts_(baseYear, monthNum, dayNum)) {
      return baseYear;
    }

    const candidate = new Date(baseYear, monthNum - 1, dayNum);
    const sixMonthsMs = 183 * 24 * 60 * 60 * 1000;

    if (candidate.getTime() < base.getTime() - sixMonthsMs) {
      return baseYear + 1;
    }

    return baseYear;
  };
}

function formatDateObject_(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  return `${y}/${m}/${d}`;
}

function getDateOfThisWeekday_(baseDate, weekdayText) {
  const weekdayMap = {
    '日曜': 0,
    '日曜日': 0,
    '月曜': 1,
    '月曜日': 1,
    '火曜': 2,
    '火曜日': 2,
    '水曜': 3,
    '水曜日': 3,
    '木曜': 4,
    '木曜日': 4,
    '金曜': 5,
    '金曜日': 5,
    '土曜': 6,
    '土曜日': 6
  };

  const targetDay = weekdayMap[weekdayText];

  if (targetDay === undefined) {
    return new Date(baseDate);
  }

  const base = new Date(baseDate);
  const diff = targetDay - base.getDay();

  base.setDate(base.getDate() + diff);

  return base;
}

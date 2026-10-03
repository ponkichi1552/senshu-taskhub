// Shared expected-results table for UI regression tests and the downloadable
// virtual test workbook. All clock values are explicit JST timestamps.
const WEEKDAY_VIEWS = [
  {date: '2026-10-05', weekday: '月'},
  {date: '2026-10-06', weekday: '火'},
  {date: '2026-10-07', weekday: '水'},
  {date: '2026-10-08', weekday: '木'},
  {date: '2026-10-09', weekday: '金'},
  {date: '2026-10-10', weekday: '土'},
  {date: '2026-10-11', weekday: '日'},
];

// Offsets 0..8 cover today through the Tuesday after the next Monday. The
// explicit rows also make the Sunday-ending week boundary reviewable.
const EXPECTED_BY_VIEW_WEEKDAY = [
  ['today', 'tomorrow', 'thisWeek', 'thisWeek', 'thisWeek', 'thisWeek', 'thisWeek', 'later', 'later'],
  ['today', 'tomorrow', 'thisWeek', 'thisWeek', 'thisWeek', 'thisWeek', 'later', 'later', 'later'],
  ['today', 'tomorrow', 'thisWeek', 'thisWeek', 'thisWeek', 'later', 'later', 'later', 'later'],
  ['today', 'tomorrow', 'thisWeek', 'thisWeek', 'later', 'later', 'later', 'later', 'later'],
  ['today', 'tomorrow', 'thisWeek', 'later', 'later', 'later', 'later', 'later', 'later'],
  ['today', 'tomorrow', 'later', 'later', 'later', 'later', 'later', 'later', 'later'],
  ['today', 'tomorrow', 'later', 'later', 'later', 'later', 'later', 'later', 'later'],
];

function addDays(dateKey, count) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + count));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function clock(date, time) {
  return Date.parse(`${date}T${time}+09:00`);
}

const matrixCases = WEEKDAY_VIEWS.flatMap((view, weekdayIndex) =>
  EXPECTED_BY_VIEW_WEEKDAY[weekdayIndex].map((expectedGroup, offset) => {
    const dueDateKey = addDays(view.date, offset);
    return {
      id: `WEEK-${view.weekday}-${String(offset).padStart(2, '0')}`,
      viewDate: view.date,
      viewAt: clock(view.date, '10:30:00.000'),
      dueDateKey,
      dueTime: '23:59',
      dueType: 'detected',
      expectedGroup,
      scenario: `${view.weekday}曜日閲覧／期限まで${offset}日（日曜を今週の最終日として分類）`,
    };
  })
);

const boundaryCases = [
  {id: 'FRIDAY-SUNDAY-WEEK', viewDate: '2026-10-09', viewAt: clock('2026-10-09', '10:30:00.000'), dueDateKey: '2026-10-11', dueTime: '23:59', dueType: 'detected', expectedGroup: 'thisWeek', scenario: '金曜閲覧の日曜締切は今週中'},
  {id: 'SATURDAY-SUNDAY-TOMORROW', viewDate: '2026-10-10', viewAt: clock('2026-10-10', '10:30:00.000'), dueDateKey: '2026-10-11', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '土曜閲覧の日曜締切は明日だけに表示'},
  {id: 'SATURDAY-MONDAY-LATER', viewDate: '2026-10-10', viewAt: clock('2026-10-10', '10:30:00.000'), dueDateKey: '2026-10-12', dueTime: '23:59', dueType: 'detected', expectedGroup: 'later', scenario: '土曜閲覧の次の月曜は来週以降'},
  {id: 'SUNDAY-MONDAY-TOMORROW', viewDate: '2026-10-11', viewAt: clock('2026-10-11', '10:30:00.000'), dueDateKey: '2026-10-12', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '日曜閲覧の次の月曜は明日'},
  {id: 'MINUTE-1230-START', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '12:30:00.000'), dueDateKey: '2026-10-08', dueTime: '12:30', dueType: 'detected', expectedGroup: 'today', scenario: '時刻付き締切の分の開始'},
  {id: 'MINUTE-1230-END', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '12:30:59.999'), dueDateKey: '2026-10-08', dueTime: '12:30', dueType: 'detected', expectedGroup: 'today', scenario: '時刻付き締切の分の最終ミリ秒'},
  {id: 'MINUTE-1231', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '12:31:00.000'), dueDateKey: '2026-10-08', dueTime: '12:30', dueType: 'detected', expectedGroup: 'expired', scenario: '時刻付き締切の次の分で期限切れ'},
  {id: 'DAY-2359-START', viewDate: '2026-10-10', viewAt: clock('2026-10-10', '23:59:00.000'), dueDateKey: '2026-10-10', dueTime: '23:59', dueType: 'detected', expectedGroup: 'today', scenario: '23:59締切の分の開始'},
  {id: 'DAY-2359-END', viewDate: '2026-10-10', viewAt: clock('2026-10-10', '23:59:59.999'), dueDateKey: '2026-10-10', dueTime: '23:59', dueType: 'detected', expectedGroup: 'today', scenario: '23:59締切の最終ミリ秒'},
  {id: 'DAY-0000', viewDate: '2026-10-11', viewAt: clock('2026-10-11', '00:00:00.000'), dueDateKey: '2026-10-10', dueTime: '23:59', dueType: 'detected', expectedGroup: 'expired', scenario: '日付が変わった直後に期限切れ'},
  {id: 'DATE-ONLY-END', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '23:59:59.999'), dueDateKey: '2026-10-08', dueTime: '', dueType: 'detected', expectedGroup: 'today', scenario: '時刻なし期限は当日23:59の最終ミリ秒まで有効'},
  {id: 'DATE-ONLY-NEXT-DAY', viewDate: '2026-10-09', viewAt: clock('2026-10-09', '00:00:00.000'), dueDateKey: '2026-10-08', dueTime: '', dueType: 'detected', expectedGroup: 'expired', scenario: '日付のみ期限の翌日0:00'},
  {id: 'MIDNIGHT-NORMALIZED-END', viewDate: '2026-10-10', viewAt: clock('2026-10-10', '23:59:59.999'), dueDateKey: '2026-10-10', dueTime: '23:59', dueType: 'detected', expectedGroup: 'today', scenario: 'メールの翌日0:00を前日23:59へ補正した後の最終ミリ秒'},
  {id: 'LEAP-DAY', viewDate: '2028-02-28', viewAt: clock('2028-02-28', '10:30:00.000'), dueDateKey: '2028-02-29', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '閏年2月28日から2月29日'},
  {id: 'NON-LEAP-FEB', viewDate: '2026-02-28', viewAt: clock('2026-02-28', '10:30:00.000'), dueDateKey: '2026-03-01', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '平年の2月28日から3月1日'},
  {id: 'MONTH-END', viewDate: '2026-10-31', viewAt: clock('2026-10-31', '10:30:00.000'), dueDateKey: '2026-11-01', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '月末から翌月初日'},
  {id: 'YEAR-END', viewDate: '2026-12-31', viewAt: clock('2026-12-31', '10:30:00.000'), dueDateKey: '2027-01-01', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '年末から翌年初日'},
  {id: 'YEAR-WEEK-BOUNDARY', viewDate: '2026-12-31', viewAt: clock('2026-12-31', '10:30:00.000'), dueDateKey: '2027-01-04', dueTime: '23:59', dueType: 'detected', expectedGroup: 'later', scenario: '年越し後の次の月曜日は来週以降'},
  {id: 'PRESET-SATURDAY-SUNDAY', viewDate: '2026-12-26', viewAt: clock('2026-12-26', '09:00:00.000'), dueDateKey: '2026-12-27', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '選択日時：土曜。日曜期限は明日'},
  {id: 'PRESET-SATURDAY-MONDAY', viewDate: '2026-12-26', viewAt: clock('2026-12-26', '09:00:00.000'), dueDateKey: '2026-12-28', dueTime: '23:59', dueType: 'detected', expectedGroup: 'later', scenario: '選択日時：土曜。翌週月曜期限は来週以降'},
  {id: 'PRESET-SUNDAY-MONDAY', viewDate: '2026-12-27', viewAt: clock('2026-12-27', '23:58:00.000'), dueDateKey: '2026-12-28', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '選択日時：日曜。翌月曜期限は明日'},
  {id: 'PRESET-WEEKDAY-SUNDAY', viewDate: '2026-12-29', viewAt: clock('2026-12-29', '10:30:00.000'), dueDateKey: '2027-01-03', dueTime: '23:59', dueType: 'detected', expectedGroup: 'thisWeek', scenario: '選択日時：平日。年越し後の日曜期限は今週中'},
  {id: 'YEAR-END-MIDNIGHT-NORMALIZED', viewDate: '2026-12-31', viewAt: clock('2026-12-31', '23:58:00.000'), dueDateKey: '2026-12-31', dueTime: '23:59', dueType: 'detected', expectedGroup: 'today', scenario: '選択日時：年末23:58。翌年1/1 0:00期限を前年23:59へ補正'},
  {id: 'YEAR-END-MIDNIGHT-LAST-MILLISECOND', viewDate: '2026-12-31', viewAt: clock('2026-12-31', '23:59:59.999'), dueDateKey: '2026-12-31', dueTime: '23:59', dueType: 'detected', expectedGroup: 'today', scenario: '年末の補正済み0:00期限は23:59分の最終ミリ秒まで有効'},
  {id: 'NEW-YEAR-MIDNIGHT-EXPIRED', viewDate: '2027-01-01', viewAt: clock('2027-01-01', '00:00:00.000'), dueDateKey: '2026-12-31', dueTime: '23:59', dueType: 'detected', expectedGroup: 'expired', scenario: '年明け00:00に前年23:59期限が切れる'},
  {id: 'NEW-YEAR-DATE-ONLY', viewDate: '2027-01-01', viewAt: clock('2027-01-01', '00:01:00.000'), dueDateKey: '2027-01-01', dueTime: '', dueType: 'detected', expectedGroup: 'today', scenario: '年明けの日付だけの期限は当日末まで有効'},
  {id: 'PRESET-MONTH-END-MAY-1', viewDate: '2027-04-30', viewAt: clock('2027-04-30', '09:00:00.000'), dueDateKey: '2027-05-01', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '選択日時：月末。翌月1日は明日'},
  {id: 'PRESET-MONTH-END-MAY-2', viewDate: '2027-04-30', viewAt: clock('2027-04-30', '09:00:00.000'), dueDateKey: '2027-05-02', dueTime: '23:59', dueType: 'detected', expectedGroup: 'thisWeek', scenario: '選択日時：月末。日曜の翌月2日は今週中'},
  {id: 'PRESET-MONTH-END-MAY-3', viewDate: '2027-04-30', viewAt: clock('2027-04-30', '09:00:00.000'), dueDateKey: '2027-05-03', dueTime: '23:59', dueType: 'detected', expectedGroup: 'later', scenario: '選択日時：月末。翌週月曜3日は来週以降'},
  {id: 'PRESET-NON-LEAP-MARCH-1', viewDate: '2027-02-28', viewAt: clock('2027-02-28', '09:00:00.000'), dueDateKey: '2027-03-01', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '平年2/28（日）から3/1（月）'},
  {id: 'PRESET-INVALID-NON-LEAP-FEB-29', viewDate: '2027-02-28', viewAt: clock('2027-02-28', '09:00:00.000'), dueDateKey: '2027-02-29', dueTime: '23:59', dueType: 'detected', expectedGroup: 'unknown', scenario: '平年の存在しない2/29を未知日にする'},
  {id: 'PRESET-LEAP-EVE-FEB-29', viewDate: '2028-02-28', viewAt: clock('2028-02-28', '09:00:00.000'), dueDateKey: '2028-02-29', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '選択日時：閏日前日。2/29は明日'},
  {id: 'PRESET-LEAP-EVE-MARCH-1', viewDate: '2028-02-28', viewAt: clock('2028-02-28', '09:00:00.000'), dueDateKey: '2028-03-01', dueTime: '23:59', dueType: 'detected', expectedGroup: 'thisWeek', scenario: '選択日時：閏日前日。3/1は今週中'},
  {id: 'PRESET-LEAP-DAY-MARCH-1', viewDate: '2028-02-29', viewAt: clock('2028-02-29', '09:00:00.000'), dueDateKey: '2028-03-01', dueTime: '23:59', dueType: 'detected', expectedGroup: 'tomorrow', scenario: '選択日時：閏日当日。3/1は明日'},
  {id: 'PRESET-JST-UTC-BOUNDARY', viewDate: '2027-01-01', viewAt: clock('2027-01-01', '00:05:00.000'), dueDateKey: '2027-01-01', dueTime: '00:04', dueType: 'detected', expectedGroup: 'expired', scenario: 'JST 1/1 00:05（UTC 12/31 15:05）で00:04期限切れ'},
  {id: 'INVALID-DATE', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '10:30:00.000'), dueDateKey: '2026-02-31', dueTime: '23:59', dueType: 'detected', expectedGroup: 'unknown', scenario: '存在しない日付を未知にする'},
  {id: 'INVALID-FORMAT', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '10:30:00.000'), dueDateKey: '2026/10/09', dueTime: '23:59', dueType: 'detected', expectedGroup: 'unknown', scenario: '日付書式不正を未知にする'},
  {id: 'MISSING-DATE', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '10:30:00.000'), dueDateKey: '', dueTime: '', dueType: 'detected', expectedGroup: 'unknown', scenario: '締切日欠落を未知にする'},
  {id: 'UNKNOWN-DUE', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '10:30:00.000'), dueDateKey: '2026-10-09', dueTime: '23:59', dueType: 'unknown', expectedGroup: 'unknown', scenario: '未検出状態の誤分類を防ぐ'},
  {id: 'NO-DEADLINE', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '10:30:00.000'), dueDateKey: '2026-10-08', dueTime: '12:00', dueType: 'none', expectedGroup: 'none', scenario: '期限なし状態を維持'},
  {id: 'INVALID-TIME', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '23:59:59.999'), dueDateKey: '2026-10-08', dueTime: 'xx:yy', dueType: 'detected', expectedGroup: 'today', scenario: '不正な時刻は日付のみと同じ23:59扱い'},
  {id: 'OUT-OF-RANGE-TIME', viewDate: '2026-10-08', viewAt: clock('2026-10-08', '23:59:59.999'), dueDateKey: '2026-10-08', dueTime: '24:00', dueType: 'detected', expectedGroup: 'today', scenario: '範囲外の時刻を日付のみと同じ23:59扱い'},
];

module.exports = {matrixCases, boundaryCases};

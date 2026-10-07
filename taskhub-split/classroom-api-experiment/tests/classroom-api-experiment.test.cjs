const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../ClassroomApiExperimentApi.gs'),
  'utf8'
);
const calls = [];

const classroom = {
  Courses: {
    list(request) {
      calls.push(['courses.list', request]);
      if (request.pageToken) {
        return { courses: [{ id: 'course-b', name: '仮想授業 B', courseState: 'ACTIVE' }] };
      }
      return {
        courses: [{ id: 'course-a', name: '仮想授業 A', courseState: 'ACTIVE' }],
        nextPageToken: 'courses-next'
      };
    },
    CourseWork: {
      list(courseId, request) {
        calls.push(['courseWork.list', courseId, request]);
        if (courseId === 'course-b') throw new Error('仮想的な授業別エラー');
        if (request.pageToken) {
          return {
            courseWork: [{
              title: '期限なし課題',
              state: 'PUBLISHED',
              updateTime: '2026-10-02T00:00:00Z'
            }]
          };
        }
        return {
          courseWork: [{
            title: '期限付き課題',
            state: 'PUBLISHED',
            dueDate: { year: 2026, month: 10, day: 20 },
            dueTime: { hours: 9, minutes: 5 },
            updateTime: '2026-10-03T00:00:00Z'
          }],
          nextPageToken: 'coursework-next'
        };
      }
    }
  }
};

const context = vm.createContext({ Classroom: classroom, Date });
vm.runInContext(source, context, { filename: 'ClassroomApiExperiment.gs' });

const result = context.getClassroomApiExperimentPreviewForWeb();
assert.equal(result.ok, true);
assert.equal(result.courseCount, 2);
assert.equal(result.courseworkCount, 2);
assert.equal(result.courseErrors.length, 1);
assert.equal(result.coursework[0].dueDate, '2026/10/20');
assert.equal(result.coursework[0].dueTime, '18:05', 'API UTC deadlines are converted to Japan time');
assert.equal(result.coursework[1].dueDate, '');
assert.equal(result.readOnly, true);
assert.equal(result.savedToSpreadsheet, false);
assert.equal('SpreadsheetApp' in context, false);
assert.equal(calls.filter(([name]) => name === 'courses.list').length, 2);
assert.equal(calls.filter(([name]) => name === 'courseWork.list').length, 3);

const targetDeadline = context.getClassroomApiLocalDuePartsForExperiment_({
  dueDate: {year: 2026, month: 10, day: 8}, dueTime: {hours: 14, minutes: 59}
});
assert.equal(targetDeadline.dueDate, '2026/10/08');
assert.equal(targetDeadline.dueTime, '23:59', '14:59 UTC maps to the observed 23:59 Japan deadline');
const utcMidnightDeadline = context.getClassroomApiLocalDuePartsForExperiment_({
  dueDate: {year: 2026, month: 10, day: 8}, dueTime: {hours: 0, minutes: 0}
});
assert.equal(utcMidnightDeadline.dueDate, '2026/10/08');
assert.equal(utcMidnightDeadline.dueTime, '09:00');
const localMidnightDeadline = context.getClassroomApiLocalDuePartsForExperiment_({
  dueDate: {year: 2026, month: 10, day: 8}, dueTime: {hours: 15, minutes: 0}
});
assert.equal(localMidnightDeadline.dueDate, '2026/10/08');
assert.equal(localMidnightDeadline.dueTime, '23:59', 'local 00:00 keeps the prior-day 23:59 product rule');

console.log('Classroom API experiment mock tests passed');

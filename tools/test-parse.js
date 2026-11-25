// Quick checks for the dictation parser:  node tools/test-parse.js
const path = require('path');
require(path.join(__dirname, '../app/js/parse.js'));
const index = require('../app/templates/index.json');
const get = (id) => require(`../app/templates/${id}.json`);
const today = new Date(2026, 10, 25);
const cases = [
  'Хемодектома, Иванов Иван Иванович, 12.03.1975, Shamblin 2, PUMCH 3',
  'хемодектома слева пациент Калдыбаев Убайдулла 5 апреля 1948 года рождения шамблин 3',
  'Эмболизация маточных артерий пациентка Ахметова Айгерим Серикқызы 1985 года рождения',
  'ЭМА Сейткали Динара 880101400123',
  'Варикоз дневной стационар Петров Петр 01.02.1960 госпитализация на 3 декабря',
  'ЧЧХС пациент Нурланов Ерлан Болатович дата рождения 14 июля 1970 года на 10 декабря',
  'консультативный лист общий пациент Смирнова Ольга 3.4.1955 диагноз I70.2 атеросклероз артерий нижних конечностей код операции 39.79',
  'эндографт, Жумабаев Серик Канатович, 23 февраля 1952',
  'стеноз внутренней сонной артерии справа эндартерэктомия Ким Виктор 1949 г.р.',
];
for (const c of cases) {
  const r = Parse.parse(c, index, get, today);
  console.log('\n>', c, '\n ', r.templateId, r.ambiguous ? '(ambiguous)' : '', JSON.stringify(r.values), r.side || '', r.opCode || '', r.notes.join('; '));
}

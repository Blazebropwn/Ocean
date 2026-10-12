import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('nickname display uppercases the first Unicode code point without changing identifiers or the rest', () => {
  const context: any = {};
  runInNewContext(readFileSync('public/display-name.js', 'utf8'), context);
  const format = context.OceanNames.formatNickname;
  for (const [input, expected] of [['blazebro','Blazebro'],['oceanmaster','Oceanmaster'],['deepHunter','DeepHunter'],['žluťoučkýKůň','ŽluťoučkýKůň'],['čESKÝ','ČESKÝ'],['e\u0301lan','E\u0301lan'],['𐐨Ocean','𐐀Ocean'],['🐙ocean','🐙ocean'],['',''],['Blazebro','Blazebro']]) assert.equal(format(input),expected);
  assert.equal(format(null),'');
  const user={id:'unchanged-id',username:'deepHunter'};
  format(user.username);
  assert.deepEqual(user,{id:'unchanged-id',username:'deepHunter'});
});

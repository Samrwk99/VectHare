import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {authenticatedContext} from '../lib/s03-security.js';

async function withRoot(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's101-host-path-'));
  try {
    await fn(tmp);
  } finally {
    await fs.rm(tmp, {recursive:true,force:true});
  }
}
function req(handle, root, vectors) {
  return {user:{profile:{handle},directories:{root,vectors}}};
}
const denied = code => e => e?.code===code;

test('S10.1 accepts the host relative DATA_ROOT and initializes only its vectors child', () => withRoot(async root => {
  const relativeRoot = path.relative(process.cwd(),root);
  const vectorDir = path.join(root,'vectors');
  const actual = await authenticatedContext(req('relative-user',relativeRoot,path.join(relativeRoot,'vectors')));
  assert.deepEqual(actual,{userScopeId:'relative-user',vectorsPath:await fs.realpath(vectorDir)});
  assert.ok((await fs.stat(vectorDir)).isDirectory());
}));

test('S10.1 accepts the host absolute root and its existing vectors directory', () => withRoot(async root => {
  const dir=path.join(root,'vectors');
  await fs.mkdir(dir);
  const result = await authenticatedContext(req('absolute-user',root,dir));
  assert.equal(result.vectorsPath,await fs.realpath(dir));
}));

test('S10.1 rejects a relative directory without a trusted host root', () => withRoot(async root => {
  await assert.rejects(authenticatedContext({user:{profile:{handle:'user'},directories:{vectors:path.relative(process.cwd(),root)}}}),denied('S03_USER_DIRECTORY_UNVERIFIED'));
}));

test('S10.1 rejects wrong child directory, parent escape, and missing host root', () => withRoot(async root => {
  await fs.mkdir(path.join(root,'vectors'));
  for (const outside of [path.join(root,'different'),path.dirname(root),root]) {
    await assert.rejects(authenticatedContext(req('user',root,outside)),denied('S03_USER_DIRECTORY_UNVERIFIED'));
  }
  await assert.rejects(authenticatedContext(req('user',path.join(root,'missing'),path.join(root,'missing','vectors'))),denied('S03_USER_DIRECTORY_UNVERIFIED'));
}));

test('S10.1 rejects a symlinked vectors directory rather than following it', () => withRoot(async root => {
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'s101-other-'));
  try {
    await fs.symlink(outside,path.join(root,'vectors'),'dir');
    await assert.rejects(authenticatedContext(req('user',root,path.join(root,'vectors'))),denied('S03_USER_DIRECTORY_UNVERIFIED'));
  } finally {await fs.rm(outside,{recursive:true,force:true});}
}));

test('S10.1 never accepts two authenticated users on the same physical vector directory', () => withRoot(async root => {
  const vectorDir=path.join(root,'vectors');
  await authenticatedContext(req('one-user',root,vectorDir));
  await assert.rejects(authenticatedContext(req('other-user',root,vectorDir)),denied('S03_SHARED_USER_ROOT'));
}));

test('S10.1 never uses request body to choose the user directory', () => withRoot(async root => {
  const context=await authenticatedContext({...req('trusted-user',root,path.join(root,'vectors')),
    body:{userScopeId:'attacker',vectorsPath:'/etc',root:'/etc'}});
  assert.equal(context.userScopeId,'trusted-user');
  assert.equal(context.vectorsPath,await fs.realpath(path.join(root,'vectors')));
}));

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { stateDirectory } from './paths.js';

export type StateDirectoryOwner={release:()=>void};
export class StateDirectoryInUseError extends Error{
  constructor(directory:string,cause:unknown){super(`The Pseudoharness state directory at ${directory} is already in use by another process. Close that instance or choose a different PSEUDOHARNESS_DATA_DIR.`,{cause});this.name='StateDirectoryInUseError';}
}

/** Keep an OS-managed SQLite write lock for the lifetime of the state owner.
 * SQLite releases the lock on process exit, so recovery never guesses whether
 * a recorded PID is stale or removes another process's lock file.
 */
export function acquireStateDirectoryOwner(directory=stateDirectory()):StateDirectoryOwner{
  mkdirSync(directory,{recursive:true,mode:0o700});
  const db=new DatabaseSync(path.join(directory,'.pseudoharness-owner.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('CREATE TABLE IF NOT EXISTS owner_lock (id INTEGER PRIMARY KEY CHECK (id = 1))');
    db.exec('BEGIN EXCLUSIVE');
  } catch(error) {
    db.close();
    const code=(error as NodeJS.ErrnoException).code;
    if(code==='SQLITE_BUSY'||code==='SQLITE_LOCKED'||/database is (?:locked|busy)/i.test(error instanceof Error?error.message:'')){
      throw new StateDirectoryInUseError(directory,error);
    }
    throw new Error(`Could not claim the Pseudoharness state directory at ${directory}. Check that it is writable and restart.`,{cause:error});
  }
  let released=false;
  return {release(){if(released)return;released=true;try{db.exec('ROLLBACK');}finally{db.close();}}};
}

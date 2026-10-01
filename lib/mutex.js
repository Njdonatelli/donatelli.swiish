'use strict';
// Runs async critical sections one at a time, in arrival order, within this process. The admin is
// one Node process on one SQLite connection, so this is enough to make check-then-write atomic.
function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => fn());
    tail = run.catch(() => {});
    return run;
  };
}

module.exports = { createMutex };

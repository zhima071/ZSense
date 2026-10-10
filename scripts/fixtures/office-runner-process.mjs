import fs from 'node:fs'
const [, , filePath, milliseconds, logPath] = process.argv
const started = Date.now()
fs.appendFileSync(logPath, JSON.stringify({ type: 'start', filePath, time: started }) + '\n')
setTimeout(() => {
  const ended = Date.now()
  fs.appendFileSync(logPath, JSON.stringify({ type: 'end', filePath, time: ended }) + '\n')
  console.log(JSON.stringify({ filePath, started, ended, noResident: process.env.OFFICECLI_NO_AUTO_RESIDENT, flush: process.env.OFFICECLI_RESIDENT_FLUSH }))
}, Number(milliseconds))

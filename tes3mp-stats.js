const fs = require('fs')
const readline = require('readline')
const URL = require('url')
const { Client } = require('pg')
const { argv } = require('process')
const client = new Client({
  connectionString: argv[2]
})

const SKIP_FACTOR = 24
const LIMIT = 1000
const masterServers = [
  "https://master.tes3mp.com/api/servers/info",
  "http://master.tes3mp.com:8080/api/servers/info",
  "http://master.tes3mp.com:8081/api/servers/info"
]

async function prepareDatabase() {
  const sql =
  `CREATE TABLE IF NOT EXISTS "population" (
    "id" bigserial PRIMARY KEY,
    "servers" bigint,
    "players" bigint,
    "date" timestamptz DEFAULT now()
  );`
  return await client.query(sql)
    .catch(err => {
      console.error(err)
    })
}

const protocolMap = {
  "http:": require('http'),
  "https:": require('https')
}
function makeRequest(url) {
  const parsedUrl = URL.parse(url)
  return protocolMap[parsedUrl.protocol].get
    .apply(protocolMap[parsedUrl.protocol], arguments)
}
async function getStats(url) {
  let rawData = ''
  return new Promise((resolve, reject) => {
    makeRequest(url, { timeout: 2000 }, res => {
      res.on('data', (d) => {
        rawData += d
      }).on('end', () => {
        resolve(rawData)
      })
    }).on('error', (e) => {
      reject(e)
    })
  })
}

async function addResult(serverCount, playerCount) {
  return await client.query(
    'INSERT INTO population(servers, players) VALUES($1, $2)',
    [ serverCount, playerCount ]
  ).catch(err => {
    console.error(err)
    return null
  })
}

function pad0to2(str) {
  str = str.toString()
  let paddingLength = 2 - str.length
  if(paddingLength > 0) {
    return '0'.repeat(paddingLength) + str
  }
  return str
}
function formatDate(date) {
  return `${date.getFullYear()}-${pad0to2(date.getMonth() + 1)}-${pad0to2(date.getDate())}` +
    ` ${pad0to2(date.getHours())}:${pad0to2(date.getMinutes())}`
}
async function updateCSV(path) {
  const sql =
  `(
    SELECT
      avg(servers) as servers,
      avg(players) as players,
      min(date) as date
    FROM population
    WHERE date < now() - interval '7 days'
    GROUP BY DATE(date)
  )
  UNION
  (
    SELECT servers, players, date FROM population
    WHERE date >= now() - interval '7 days'
  )
  ORDER BY date`

  const res = await client.query(sql)
  const file = fs.openSync(path, 'w')

  for(let row of res.rows) {
    const date = row.date
    const line = `${formatDate(date)},${Math.round(row.servers)},${Math.round(row.players)}\n`
    fs.writeSync(file, line)
  }
  fs.closeSync(file)
}

async function saveLines(lines) {
  console.log(`Saving ${lines.length} lines...`)
  let sql = []
  let params = []
  for(const i in lines) {
    const line = lines[i]
    const columns = line.split(',')
    if (columns.length < 3) return null
    const date = new Date(columns[0])
    const servers = parseInt(columns[1])
    const players = parseInt(columns[2])
    sql.push(`($${3 * i + 1}, $${3 * i + 2}, $${3 * i + 3})`)
    params.push(servers, players, date)
  }
  const finalSql = `INSERT INTO population(servers, players, date) VALUES\n`
    + sql.join(",\n")
  return await client.query(finalSql, params)
    .catch(e => {
      console.error(`Error for\n${lines.join("\n")}`)
      console.error(e.error)
      return null
    })
}
async function importCSV(path) {
  return new Promise((resolve, reject) => {
    let lines = []
    const promises = []
    const rl = readline.createInterface(fs.createReadStream(path))
    rl.on('line', line => {
      if(line != "") lines.push(line)
      if (lines.length >= LIMIT) {
        promises.push(saveLines(lines))
        lines = []
      }
    })
    rl.on('close', async () => {
      if (lines.length >= 0) {
        promises.push(saveLines(lines))
      }
      resolve(await Promise.all(promises))
    })    
  })
}

async function clearDatabase() {
  return await client.query("DELETE FROM population")
}

async function main() {
  console.log("Connecting...")
  await client.connect()
  console.log("Connected!")
  if(argv[3] == 'prepare') {
    console.log("Preparing database...")
    await prepareDatabase()
  }
  else if(argv[3] == 'import') {
    console.log("Importing existing records...")
    await importCSV(argv[4])
  }
  else if(argv[3] == 'fetch') {
    let serverCount = 0
    let playerCount = 0
    const httpPromises = []
    for(let url of masterServers) {
      console.log(`Fetching ${url}...`)
      httpPromises.push(getStats(url)
        .then(data => {
          if (data !== null) {
            try {
              const json = JSON.parse(data)
              serverCount += json.servers
              playerCount += json.players
              console.error(`Successfully fetched ${url}!`)
            }
            catch(e) {
              console.error(e)
            }
          }
        })
        .catch(e => {
          console.error(`Failed to fetch ${url}`)
          console.error(e)
          return null
        })
      )
    }
    await Promise.all(httpPromises)
    console.log(`${serverCount} servers and ${playerCount} players!`)          
    console.log(`Saving in the database...`)
    await addResult(serverCount, playerCount)
    console.log(`Generating CSV...`)
    await updateCSV(argv[4])
  }
  else if(argv[3] == 'clear') {
    console.log(`Clearing the database...`)
    await clearDatabase()
  }
  console.log(`Done!`)
  await client.end()
}
main()
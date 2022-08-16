const minecraftBedrockPing = require('mcpe-ping-fixed')
const mcping = require('minecraft-server-util')
const axios = require('axios')

const logger = require('./logger')
const MessageOf = require('./message')
const { TimeTracker } = require('./time')

const { getPlayerCountOrNull } = require('./util')

const config = require('../config')

function ping (serverRegistration, timeout, callback, version) {
  switch (serverRegistration.data.type) {
    case 'PC':
      serverRegistration.dnsResolver.resolve((host, port, remainingTimeout) => {
        const options = {
          timeout: config.rates.connectTimeout, // timeout in milliseconds
          enableSRV: true // SRV record lookup
        }

        if (serverRegistration.data.api != null && serverRegistration.data.api) {
          axios('https://mcapi.xdefcon.com/server/' + `${host}:${port || 25565}` + '/full/json')
            .then(function (response) {
              // handle success
              if (response.data.serverStatus === 'offline') {
                // eslint-disable-next-line node/no-callback-literal
                callback('Error when connecting to the server.')
                return
              }

              const payload = {
                players: {
                  online: capPlayerCount(serverRegistration.data.ip, parseInt(response.data.players))
                },
                version: parseInt(response.data.protocol.replace('v', ''))
              }

              // Ensure the returned favicon is a data URI
              if (response.data.icon && response.data.icon.startsWith('data:image/')) {
                payload.favicon = response.data.icon
              }

              callback(null, payload)
            })
            .catch(function (error) {
              // handle error
              callback(error)
            })
          return
        }

        // The port and options arguments are optional, the
        // port will default to 25565 and the options will
        // use the default options.
        mcping.status(host, port || 25565, options)
          .then((result) => {
            const payload = {
              players: {
                online: capPlayerCount(serverRegistration.data.ip, parseInt(result.players.online.toString()))
              },
              version: parseInt(result.version.protocol.toString())
            }

            // Ensure the returned favicon is a data URI
            if (result.favicon && result.favicon.startsWith('data:image/')) {
              payload.favicon = result.favicon
            }

            callback(null, payload)
          })
          .catch((error) => callback(error))
      })
      break

    case 'PE':
      minecraftBedrockPing(serverRegistration.data.ip, serverRegistration.data.port || 19132, (err, res) => {
        if (err) {
          callback(err)
        } else {
          callback(null, {
            players: {
              online: capPlayerCount(serverRegistration.data.ip, parseInt(res.currentPlayers))
            }
          })
        }
      }, timeout)
      break

    default:
      throw new Error('Unsupported type: ' + serverRegistration.data.type)
  }
}

// player count can be up to 1^32-1, which is a massive scale and destroys browser performance when rendering graphs
// Artificially cap and warn to prevent propogating garbage
function capPlayerCount (host, playerCount) {
  const maxPlayerCount = 250000

  if (playerCount !== Math.min(playerCount, maxPlayerCount)) {
    logger.log('warn', '%s returned a player count of %d, Minetrack has capped it to %d to prevent browser performance issues with graph rendering. If this is in error, please edit maxPlayerCount in ping.js!', host, playerCount, maxPlayerCount)

    return maxPlayerCount
  } else if (playerCount !== Math.max(playerCount, 0)) {
    logger.log('warn', '%s returned an invalid player count of %d, setting to 0.', host, playerCount)

    return 0
  }
  return playerCount
}

class PingController {
  constructor (app) {
    this._app = app
    this._isRunningTasks = false
  }

  schedule () {
    setInterval(this.pingAll, config.rates.pingAll)

    this.pingAll()
  }

  pingAll = () => {
    const {
      timestamp,
      updateHistoryGraph
    } = this._app.timeTracker.newPointTimestamp()

    this.startPingTasks(results => {
      const updates = []

      for (const serverRegistration of this._app.serverRegistrations) {
        const result = results[serverRegistration.serverId]

        // Log to database if enabled
        // Use null to represent a failed ping
        if (config.logToDatabase) {
          const unsafePlayerCount = getPlayerCountOrNull(result.resp)

          this._app.database.insertPing(serverRegistration.data.ip, timestamp, unsafePlayerCount)
        }

        // Generate a combined update payload
        // This includes any modified fields and flags used by the frontend
        // This will not be cached and can contain live metadata
        const update = serverRegistration.handlePing(timestamp, result.resp, result.err, result.version, updateHistoryGraph)

        updates[serverRegistration.serverId] = update
      }

      // Send object since updates uses serverIds as keys
      // Send a single timestamp entry since it is shared
      this._app.server.broadcast(MessageOf('updateServers', {
        timestamp: TimeTracker.toSeconds(timestamp),
        updateHistoryGraph,
        updates
      }))
    })
  }

  startPingTasks = (callback) => {
    if (this._isRunningTasks) {
      logger.log('warn', 'Started re-pinging servers before the last loop has finished! You may need to increase "rates.pingAll" in config.json')

      return
    }

    this._isRunningTasks = true

    const results = []

    for (const serverRegistration of this._app.serverRegistrations) {
      const version = serverRegistration.getNextProtocolVersion()

      ping(serverRegistration, config.rates.connectTimeout, (err, resp) => {
        if (err && config.logFailedPings !== false) {
          logger.log('error', 'Failed to ping %s: %s', serverRegistration.data.ip, err.message)
        }

        results[serverRegistration.serverId] = {
          resp,
          err,
          version
        }

        if (Object.keys(results).length === this._app.serverRegistrations.length) {
          // Loop has completed, release the locking flag
          this._isRunningTasks = false

          callback(results)
        }
      }, version.protocolId)
    }
  }
}

module.exports = PingController

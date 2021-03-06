// @flow

import http from 'cli-engine-command/lib/http'
import type HTTPError from 'http-call'
import type Command from './command'
import yubikey from './yubikey'
import Mutex from './mutex'

type Options = {
  required?: boolean,
  preauth?: boolean
}

type HerokuAPIErrorOptions = $Shape<{
  resource: ?string,
  app: ?{id: ?string, name: ?string},
  id: ?string,
  message: ?string,
  url: ?string
}>

export class HerokuAPIError extends Error {
  http: HTTPError
  body: HerokuAPIErrorOptions

  constructor (httpError: HTTPError) {
    let options: HerokuAPIErrorOptions = httpError.body
    if (!options.message) throw httpError
    let info = []
    if (options.id) info.push(`Error ID: ${options.id}`)
    if (options.app && options.app.name) info.push(`App: ${options.app.name}`)
    if (options.url) info.push(`See ${options.url} for more information.`)
    if (info.length) super([options.message, ''].concat(info).join('\n'))
    else super(options.message)
    this.http = httpError
    this.body = options
  }
}

export default class Heroku extends http {
  cmd: Command
  options: Options
  twoFactorMutex: Mutex
  preauthPromises: {[k: string]: Promise<*>}

  constructor (command: Command, options: Options = {}) {
    super(command.out)
    if (options.required === undefined) options.required = true
    options.preauth = options.preauth !== false
    this.cmd = command
    this.options = options
    this.requestOptions.host = 'api.heroku.com'
    this.requestOptions.protocol = 'https:'
    if (this.auth) this.requestOptions.headers['authorization'] = `Bearer ${this.auth}`
    this.requestOptions.headers['user-agent'] = `heroku-cli/${this.out.config.version}`
    this.requestOptions.headers['accept'] = 'application/vnd.heroku+json; version=3'
    this.twoFactorMutex = new Mutex()
    this.preauthPromises = {}
    let self = this
    this.http = class extends this.http {
      static async twoFactorRetry (err, url, opts = {}, retries = 3) {
        const app = err.body.app ? err.body.app.name : null
        if (!app || !options.preauth) {
          opts.headers['Heroku-Two-Factor-Code'] = await self.twoFactorPrompt()
          return this.request(url, opts, retries)
        } else {
          // if multiple requests are run in parallel for the same app, we should
          // only preauth for the first so save the fact we already preauthed
          if (!self.preauthPromises[app]) {
            self.preauthPromises[app] = self.twoFactorPrompt().then(factor => self.preauth(app, factor))
          }

          await self.preauthPromises[app]
          return this.request(url, opts, retries)
        }
      }

      static async request (url, opts, retries = 3) {
        retries--
        try {
          return await super.request(url, opts)
        } catch (err) {
          if (!err.__httpcall) throw err
          let apiError = new HerokuAPIError(err)
          if (retries > 0) {
            if (apiError.http.statusCode === 403 && apiError.body.id === 'two_factor') {
              return this.twoFactorRetry(apiError, url, opts, retries)
            }
          }
          throw apiError
        }
      }
    }
  }

  get auth (): ?string {
    let auth = process.env.HEROKU_API_KEY
    if (!auth) {
      const Netrc = require('netrc-parser')
      const netrc = new Netrc()
      auth = netrc.machines[require('./vars').default.apiHost].password
    }
    // TODO: handle required
    return auth
  }

  twoFactorPrompt () {
    yubikey.enable()
    return this.twoFactorMutex.synchronize(async () => {
      try {
        let factor = await this.out.prompt('Two-factor code', {mask: true})
        yubikey.disable()
        return factor
      } catch (err) {
        yubikey.disable()
        throw err
      }
    })
  }

  preauth (app: string, factor: string) {
    return this.put(`/apps/${app}/pre-authorizations`, {
      headers: { 'Heroku-Two-Factor-Code': factor }
    })
  }
}

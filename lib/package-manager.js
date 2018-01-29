const _ = require('underscore-plus')
const {BufferedProcess, CompositeDisposable, Emitter} = require('atom')
const semver = require('semver')

const Client = require('./atom-io-client')

module.exports = class PackageManager {
  constructor () {
    this.CACHE_EXPIRY = 1000 * 60 * 10
    this.packagePromises = []
    this.apmCache = {}
    this.clearOutdatedCache()
    this.emitter = new Emitter()
  }

  getClient () {
    if (!this.client) {
      this.client = new Client(this)
    }
    return this.client
  }

  isPackageInstalled (packageName) {
    return (
      atom.packages.isPackageLoaded(packageName) || atom.packages.getAvailablePackageNames().indexOf(packageName) > -1
    )
  }

  packageHasSettings (packageName) {
    for (const grammar of atom.grammars.getGrammars()) {
      if (grammar.path && grammar.packageName === packageName) {
        return true
      }
    }

    const pack = atom.packages.getLoadedPackage(packageName)
    if (pack && !atom.packages.isPackageActive(packageName)) {
      pack.activateConfig()
    }
    const schema = atom.config.getSchema(packageName)
    return schema && schema.type !== 'any'
  }

  setProxyServersAsync (callback) {
    return Promise.all([
      atom.resolveProxy('http://atom.io').then(proxy => this.applyProxyToEnv('http_proxy', proxy)),
      atom.resolveProxy('https://atom.io').then(proxy => this.applyProxyToEnv('https_proxy', proxy))
    ]).then(callback)
  }

  applyProxyToEnv (envName, proxy) {
    if (proxy != null) {
      proxy = proxy.split(' ')
      switch (proxy[0].trim().toUpperCase()) {
        case 'DIRECT':
          delete process.env[envName]
          break
        case 'PROXY':
          process.env[envName] = `http://${proxy[1]}`
          break
      }
    }
  }

  runCommand (args, callback) {
    const command = atom.packages.getApmPath()
    const outputLines = []
    const stdout = lines => outputLines.push(lines)
    const errorLines = []
    const stderr = lines => errorLines.push(lines)
    const exit = code => callback(code, outputLines.join('\n'), errorLines.join('\n'))

    args.push('--no-color')

    const options = {command, args, stdout, stderr, exit}
    if (atom.config.get('core.useProxySettingsWhenCallingApm')) {
      options.autoStart = false
      const bufferedProcess = new BufferedProcess(options)
      this.setProxyServersAsync(() => bufferedProcess.start())
      return bufferedProcess
    } else {
      return new BufferedProcess(options)
    }
  }

  loadInstalled (callback) {
    const args = ['ls', '--json']
    const errorMessage = 'Fetching local packages failed.'
    return this.runApmCommandAndParseJSON(args, errorMessage, callback)
  }

  loadFeatured (loadThemes, callback) {
    if (!callback) {
      callback = loadThemes
      loadThemes = false
    }

    const args = ['featured', '--json']
    const version = atom.getVersion()
    if (loadThemes) {
      args.push('--themes')
    }
    if (semver.valid(version)) {
      args.push('--compatible', version)
    }
    const errorMessage = 'Fetching featured packages failed.'
    return this.runApmCommandAndParseJSON(args, errorMessage, callback)
  }

  loadOutdated (clearCache, callback) {
    if (clearCache) {
      this.clearOutdatedCache()
      // Short circuit if we have cached data.
    } else if (this.apmCache.loadOutdated.value && this.apmCache.loadOutdated.expiry > Date.now()) {
      return callback(null, this.apmCache.loadOutdated.value)
    }

    const args = ['outdated', '--json']
    const version = atom.getVersion()
    if (semver.valid(version)) {
      args.push('--compatible', version)
    }
    const errorMessage = 'Fetching outdated packages and themes failed.'

    const apmProcess = this.runCommand(args, (code, stdout, stderr) => {
      if (code === 0) {
        let packages
        try {
          packages = JSON.parse(stdout) || []
        } catch (parseError) {
          const error = createJsonParseError(errorMessage, parseError, stdout)
          return callback(error)
        }

        const versionPinnedPackages = this.getVersionPinnedPackages()
        const updatablePackages = packages.filter(pack => !versionPinnedPackages.includes(pack.name))
        this.setLoadOutdated(updatablePackages, Date.now() + this.CACHE_EXPIRY)
        updatablePackages.forEach(pack => this.emitPackageEvent('update-available', pack))

        return callback(null, updatablePackages)
      } else {
        const error = new Error(errorMessage)
        error.stdout = stdout
        error.stderr = stderr
        return callback(error)
      }
    })

    return handleProcessErrors(apmProcess, errorMessage, callback)
  }

  getVersionPinnedPackages () {
    return atom.config.get('core.versionPinnedPackages') || []
  }

  setLoadOutdated (value, expiry) {
    this.apmCache.loadOutdated = {value, expiry}
  }

  clearOutdatedCache () {
    this.setLoadOutdated(null, 0)
  }

  // executeAp
  runApmCommandAndParseJSON (args, errorMessage, callback) {
    const apmProcess = this.runCommand(args, (code, stdout, stderr) => {
      if (code === 0) {
        let packages
        try {
          packages = JSON.parse(stdout) || []
        } catch (parseError) {
          const error = createJsonParseError(errorMessage, parseError, stdout)
          return callback(error)
        }

        return callback(null, packages)
      } else {
        const error = new Error(errorMessage)
        error.stdout = stdout
        error.stderr = stderr
        return callback(error)
      }
    })

    return handleProcessErrors(apmProcess, errorMessage, callback)
  }

  loadPackage (packageName, callback) {
    const args = ['view', packageName, '--json']
    const errorMessage = `Fetching package '${packageName}' failed.`
    return this.runApmCommandAndParseJSON(args, errorMessage, callback)
  }

  loadCompatiblePackageVersion (packageName, callback) {
    const args = ['view', packageName, '--json', '--compatible', this.normalizeVersion(atom.getVersion())]
    const errorMessage = `Fetching package '${packageName}' failed.`

    return this.runApmCommandAndParseJSON(args, errorMessage, callback)
  }

  getInstalled () {
    return new Promise((resolve, reject) => {
      this.loadInstalled((error, result) => {
        if (error) {
          reject(error)
        } else {
          resolve(result)
        }
      })
    })
  }

  getFeatured (loadThemes) {
    return new Promise((resolve, reject) => {
      return this.loadFeatured(!!loadThemes, function (error, result) {
        if (error) {
          return reject(error)
        } else {
          return resolve(result)
        }
      })
    })
  }

  getOutdated (clearCache) {
    if (clearCache == null) {
      clearCache = false
    }
    return new Promise((resolve, reject) => {
      return this.loadOutdated(clearCache, function (error, result) {
        if (error) {
          return reject(error)
        } else {
          return resolve(result)
        }
      })
    })
  }

  getPackage (packageName) {
    return this.packagePromises[packageName] != null
      ? this.packagePromises[packageName]
      : (this.packagePromises[packageName] = new Promise((resolve, reject) => {
        return this.loadPackage(packageName, function (error, result) {
          if (error) {
            return reject(error)
          } else {
            return resolve(result)
          }
        })
      }))
  }

  satisfiesVersion (version, metadata) {
    const engine =
      (metadata.engines != null ? metadata.engines.atom : undefined) != null
        ? metadata.engines != null ? metadata.engines.atom : undefined
        : '*'
    if (!semver.validRange(engine)) {
      return false
    }
    return semver.satisfies(version, engine)
  }

  normalizeVersion (version) {
    if (typeof version === 'string') {
      ;[version] = Array.from(version.split('-'))
    }
    return version
  }

  update (pack, newVersion, callback) {
    let args
    const {name, theme, apmInstallSource} = pack

    const errorMessage = newVersion
      ? `Updating to \u201C${name}@${newVersion}\u201D failed.`
      : 'Updating to latest sha failed.'
    const onError = error => {
      error.packageInstallError = !theme
      this.emitPackageEvent('update-failed', pack, error)
      return typeof callback === 'function' ? callback(error) : undefined
    }

    if ((apmInstallSource != null ? apmInstallSource.type : undefined) === 'git') {
      args = ['install', apmInstallSource.source]
    } else {
      args = ['install', `${name}@${newVersion}`]
    }

    const exit = (code, stdout, stderr) => {
      if (code === 0) {
        this.clearOutdatedCache()
        if (typeof callback === 'function') {
          callback()
        }
        return this.emitPackageEvent('updated', pack)
      } else {
        const error = new Error(errorMessage)
        error.stdout = stdout
        error.stderr = stderr
        return onError(error)
      }
    }

    this.emitPackageEvent('updating', pack)
    const apmProcess = this.runCommand(args, exit)
    return handleProcessErrors(apmProcess, errorMessage, onError)
  }

  unload (name) {
    if (atom.packages.isPackageLoaded(name)) {
      if (atom.packages.isPackageActive(name)) {
        atom.packages.deactivatePackage(name)
      }
      return atom.packages.unloadPackage(name)
    }
  }

  install (pack, callback) {
    let {name, version, theme} = pack
    const activateOnSuccess = !theme && !atom.packages.isPackageDisabled(name)
    const activateOnFailure = atom.packages.isPackageActive(name)
    const nameWithVersion = version != null ? `${name}@${version}` : name

    this.unload(name)
    const args = ['install', nameWithVersion, '--json']

    const errorMessage = `Installing \u201C${nameWithVersion}\u201D failed.`
    const onError = error => {
      error.packageInstallError = !theme
      this.emitPackageEvent('install-failed', pack, error)
      return typeof callback === 'function' ? callback(error) : undefined
    }

    const exit = (code, stdout, stderr) => {
      if (code === 0) {
        // get real package name from package.json
        try {
          const packageInfo = JSON.parse(stdout)[0]
          pack = Object.assign({}, pack, packageInfo.metadata)
          name = pack.name
        } catch (err) {}
        // using old apm without --json support
        this.clearOutdatedCache()
        if (activateOnSuccess) {
          atom.packages.activatePackage(name)
        } else {
          atom.packages.loadPackage(name)
        }

        if (typeof callback === 'function') {
          callback()
        }
        return this.emitPackageEvent('installed', pack)
      } else {
        if (activateOnFailure) {
          atom.packages.activatePackage(name)
        }
        const error = new Error(errorMessage)
        error.stdout = stdout
        error.stderr = stderr
        return onError(error)
      }
    }

    this.emitPackageEvent('installing', pack)
    const apmProcess = this.runCommand(args, exit)
    return handleProcessErrors(apmProcess, errorMessage, onError)
  }

  uninstall (pack, callback) {
    const {name} = pack

    if (atom.packages.isPackageActive(name)) {
      atom.packages.deactivatePackage(name)
    }

    const errorMessage = `Uninstalling \u201C${name}\u201D failed.`
    const onError = error => {
      this.emitPackageEvent('uninstall-failed', pack, error)
      return typeof callback === 'function' ? callback(error) : undefined
    }

    this.emitPackageEvent('uninstalling', pack)
    const apmProcess = this.runCommand(['uninstall', '--hard', name], (code, stdout, stderr) => {
      if (code === 0) {
        this.clearOutdatedCache()
        this.unload(name)
        this.removePackageNameFromDisabledPackages(name)
        if (typeof callback === 'function') {
          callback()
        }
        return this.emitPackageEvent('uninstalled', pack)
      } else {
        const error = new Error(errorMessage)
        error.stdout = stdout
        error.stderr = stderr
        return onError(error)
      }
    })

    return handleProcessErrors(apmProcess, errorMessage, onError)
  }

  installAlternative (pack, alternativePackageName, callback) {
    const eventArg = {pack, alternative: alternativePackageName}
    this.emitter.emit('package-installing-alternative', eventArg)

    const uninstallPromise = new Promise((resolve, reject) => {
      return this.uninstall(pack, function (error) {
        if (error) {
          return reject(error)
        } else {
          return resolve()
        }
      })
    })

    const installPromise = new Promise((resolve, reject) => {
      return this.install({name: alternativePackageName}, function (error) {
        if (error) {
          return reject(error)
        } else {
          return resolve()
        }
      })
    })

    return Promise.all([uninstallPromise, installPromise])
      .then(() => {
        callback(null, eventArg)
        return this.emitter.emit('package-installed-alternative', eventArg)
      })
      .catch(error => {
        console.error(error.message, error.stack)
        callback(error, eventArg)
        eventArg.error = error
        return this.emitter.emit('package-install-alternative-failed', eventArg)
      })
  }

  canUpgrade (installedPackage, availableVersion) {
    if (installedPackage == null) {
      return false
    }

    const installedVersion = installedPackage.metadata.version
    if (!semver.valid(installedVersion)) {
      return false
    }
    if (!semver.valid(availableVersion)) {
      return false
    }

    return semver.gt(availableVersion, installedVersion)
  }

  getPackageTitle ({name}) {
    return _.undasherize(_.uncamelcase(name))
  }

  getRepositoryUrl ({metadata}) {
    let left
    const {repository} = metadata
    let repoUrl =
      (left =
        (repository != null ? repository.url : undefined) != null
          ? repository != null ? repository.url : undefined
          : repository) != null
        ? left
        : ''
    if (repoUrl.match('git@github')) {
      const repoName = repoUrl.split(':')[1]
      repoUrl = `https://github.com/${repoName}`
    }
    return repoUrl
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
      .replace(/^git\+/, '')
  }

  checkNativeBuildTools () {
    return new Promise((resolve, reject) => {
      const apmProcess = this.runCommand(['install', '--check'], function (code, stdout, stderr) {
        if (code === 0) {
          return resolve()
        } else {
          return reject(new Error())
        }
      })

      return apmProcess.onWillThrowError(function ({error, handle}) {
        handle()
        return reject(error)
      })
    })
  }

  removePackageNameFromDisabledPackages (packageName) {
    return atom.config.removeAtKeyPath('core.disabledPackages', packageName)
  }

  // Emits the appropriate event for the given package.
  //
  // All events are either of the form `theme-foo` or `package-foo` depending on
  // whether the event is for a theme or a normal package. This method standardizes
  // the logic to determine if a package is a theme or not and formats the event
  // name appropriately.
  //
  // eventName - The event name suffix {String} of the event to emit.
  // pack - The package for which the event is being emitted.
  // error - Any error information to be included in the case of an error.
  emitPackageEvent (eventName, pack, error) {
    eventName = pack.theme || (pack.metadata && pack.metadata.theme) ? `theme-${eventName}` : `package-${eventName}`
    return this.emitter.emit(eventName, {pack, error})
  }

  on (selectors, callback) {
    const subscriptions = new CompositeDisposable()
    for (const selector of selectors.split(' ')) {
      subscriptions.add(this.emitter.on(selector, callback))
    }
    return subscriptions
  }
}

function createJsonParseError (message, parseError, stdout) {
  const error = new Error(message)
  error.stdout = ''
  error.stderr = `${parseError.message}: ${stdout}`
  return error
}

function createProcessError (message, processError) {
  const error = new Error(message)
  error.stdout = ''
  error.stderr = processError.message
  return error
}

function handleProcessErrors (apmProcess, message, callback) {
  return apmProcess.onWillThrowError(function ({error, handle}) {
    handle()
    return callback(createProcessError(message, error))
  })
}

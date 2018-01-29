const fs = require('fs-plus')
const path = require('path')
const {remote} = require('electron')

const glob = require('glob')
const request = require('request')

module.exports = class AtomIoClient {
  constructor (packageManager, baseURL = 'https://atom.io/api/') {
    this.packageManager = packageManager
    this.baseURL = baseURL
    // 12 hour expiry
    this.expiry = 1000 * 60 * 60 * 12
    this.createAvatarCache()
    this.expireAvatarCache()
  }

  // Public: Get an avatar image from the filesystem, fetching it first if necessary
  avatar (login, callback) {
    return this.cachedAvatar(login, (err, cached) => {
      let stale
      if (cached) {
        stale = Date.now() - parseInt(cached.split('-').pop()) > this.expiry
      }
      if (cached && (!stale || !this.online())) {
        return callback(null, cached)
      } else {
        return this.fetchAndCacheAvatar(login, callback)
      }
    })
  }

  // Public: get a package from the atom.io API, with the appropriate level of
  // caching.
  package (name, callback) {
    const packagePath = `packages/${name}`
    return this.fetchFromCache(packagePath, {}, (err, data) => {
      if (data) {
        return callback(null, data)
      } else {
        return this.request(packagePath, callback)
      }
    })
  }

  featuredPackages (callback) {
    // TODO clean up caching copypasta
    return this.fetchFromCache('packages/featured', {}, (err, data) => {
      if (data) {
        return callback(null, data)
      } else {
        return this.getFeatured(false, callback)
      }
    })
  }

  featuredThemes (callback) {
    // TODO clean up caching copypasta
    return this.fetchFromCache('themes/featured', {}, (err, data) => {
      if (data) {
        return callback(null, data)
      } else {
        return this.getFeatured(true, callback)
      }
    })
  }

  getFeatured (loadThemes, callback) {
    // apm already does this, might as well use it instead of request i guess? The
    // downside is that I need to repeat caching logic here.
    return this.packageManager
      .getFeatured(loadThemes)
      .then(packages => {
        // copypasta from below
        const key = loadThemes ? 'themes/featured' : 'packages/featured'
        const cached = {
          data: packages,
          createdOn: Date.now()
        }
        localStorage.setItem(this.cacheKeyForPath(key), JSON.stringify(cached))
        // end copypasta
        return callback(null, packages)
      })
      .catch(error => callback(error, null))
  }

  request (path, callback) {
    const options = {
      url: `${this.baseURL}${path}`,
      headers: {'User-Agent': navigator.userAgent},
      json: true,
      gzip: true
    }

    return request(options, (err, res, body) => {
      if (err) {
        return callback(err)
      }

      delete body.versions
      const cached = {
        data: body,
        createdOn: Date.now()
      }
      localStorage.setItem(this.cacheKeyForPath(path), JSON.stringify(cached))
      return callback(err, cached.data)
    })
  }

  cacheKeyForPath (path) {
    return `settings-view:${path}`
  }

  online () {
    return navigator.onLine
  }

  // This could use a better name, since it checks whether it's appropriate to return
  // the cached data and pretends it's null if it's stale and we're online
  fetchFromCache (packagePath, options, callback) {
    if (!callback) {
      callback = options
      options = {}
    }

    if (!options.force) {
      // Set `force` to true if we can't reach the network.
      options.force = !this.online()
    }

    let cached = localStorage.getItem(this.cacheKeyForPath(packagePath))
    cached = cached ? JSON.parse(cached) : undefined
    if (cached != null && (!this.online() || options.force || Date.now() - cached.createdOn < this.expiry)) {
      if (cached == null) {
        cached = {data: {}}
      }
      return callback(null, cached.data)
    } else if (cached == null && !this.online()) {
      // The user hasn't requested this resource before and there's no way for us
      // to get it to them so just hand back an empty object so callers don't crash
      return callback(null, {})
    } else {
      // falsy data means "try to hit the network"
      return callback(null, null)
    }
  }

  createAvatarCache () {
    return fs.makeTree(this.getCachePath())
  }

  avatarPath (login) {
    return path.join(this.getCachePath(), `${login}-${Date.now()}`)
  }

  cachedAvatar (login, callback) {
    return glob(this.avatarGlob(login), (err, files) => {
      if (err) {
        return callback(err)
      }
      files.sort().reverse()
      for (const imagePath of files) {
        const filename = path.basename(imagePath)
        const array = filename.split('-'),
          createdOn = array[array.length - 1]
        if (Date.now() - parseInt(createdOn) < this.expiry) {
          return callback(null, imagePath)
        }
      }
      return callback(null, null)
    })
  }

  avatarGlob (login) {
    return path.join(this.getCachePath(), `${login}-*([0-9])`)
  }

  fetchAndCacheAvatar (login, callback) {
    if (!this.online()) {
      return callback(null, null)
    } else {
      const imagePath = this.avatarPath(login)
      const requestObject = {
        url: `https://avatars.githubusercontent.com/${login}`,
        headers: {'User-Agent': navigator.userAgent}
      }
      return request.head(requestObject, function (error, response, body) {
        if (error != null || response.statusCode !== 200 || !response.headers['content-type'].startsWith('image/')) {
          return callback(error)
        } else {
          const writeStream = fs.createWriteStream(imagePath)
          writeStream.on('finish', () => callback(null, imagePath))
          writeStream.on('error', function (error) {
            writeStream.close()
            try {
              if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath)
              }
            } catch (error1) {}
            return callback(error)
          })
          return request(requestObject).pipe(writeStream)
        }
      })
    }
  }

  // The cache expiry doesn't need to be clever, or even compare dates, it just
  // needs to always keep around the newest item, and that item only. The localStorage
  // cache updates in place, so it doesn't need to be purged.

  expireAvatarCache () {
    const deleteAvatar = child => {
      const avatarPath = path.join(this.getCachePath(), child)
      fs.unlink(avatarPath, function (error) {
        if (error && error.code !== 'ENOENT') {
          // Ignore cache paths that don't exist
          return console.warn(`Error deleting avatar (${error.code}): ${avatarPath}`)
        }
      })
    }

    return fs.readdir(this.getCachePath(), function (error, _files) {
      let key
      if (_files == null) {
        _files = []
      }
      const files = {}
      for (const filename of _files) {
        const parts = filename.split('-')
        const stamp = parts.pop()
        key = parts.join('-')
        if (!files[key]) files[key] = []
        files[key].push(`${key}-${stamp}`)
      }

      // return (() =>
      // const result = []
      for (const key in files) {
        const children = files[key]
        children.sort()
        children.pop() // keep
        // Right now a bunch of clients might be instantiated at once, so
        // we can just ignore attempts to unlink files that have already been removed
        // - this should be fixed with a singleton client
        children.forEach(deleteAvatar)
      }
    })
  }

  getCachePath () {
    if (!this.cachePath) {
      this.cachePath = path.join(remote.app.getPath('userData'), 'Cache', 'settings-view')
    }
    return this.cachePath
  }

  search (query, options) {
    options = {
      url: `${this.baseURL}packages/search`,
      headers: {'User-Agent': navigator.userAgent},
      qs: {
        q: query,
        filter: options.themes ? 'theme' : 'package'
      },
      json: true,
      gzip: true
    }

    return new Promise(function (resolve, reject) {
      request(options, function (err, res, body) {
        if (err) {
          const error = new Error(`Searching for \u201C${query}\u201D failed.`)
          error.stderr = err.message
          reject(error)
        } else {
          resolve(
            body
              .filter(pkg => pkg.releases && releases.latest)
              .map(({readme, metadata, downloads, stargazers_count}) =>
                Object.assign(metadata, {readme, downloads, stargazers_count})
              )
              .sort((a, b) => b.downloads - a.downloads)
          )
        }
      })
    })
  }
}

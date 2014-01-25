(function(global) {

  var syncInterval = 10000;

  /**
   * Class: RemoteStorage.Sync
   **/
  RemoteStorage.Sync = function(setLocal, setRemote, setAccess, setCaching) {
    this.local = setLocal;
    this.local.onDiff(function(path) {
      this.addTask(path);
      this.doTasks();
    }.bind(this));
    this.remote = setRemote;
    this.access = setAccess;
    this.caching = setCaching;
    this._tasks = {};
    this._running = {};
    this._timeStarted = {};
    RemoteStorage.eventHandling(this, 'done');
  }
  RemoteStorage.Sync.prototype = {
    now: function() {
      return new Date().getTime();
    },
    queueGetRequest: function(path, promise) {
      console.log('get request queued', path, promise);
      if (!this.remote.connected) {
        promise.reject('cannot fulfill maxAge requirement - remote is not connected');
      } else if (!this.remote.online) {
        promise.reject('cannot fulfill maxAge requirement - remote is not online');
      } else {
        this.addTask(path, function() {
            console.log('fulfilling task get', path);
          this.local.get(path).then(function(status, bodyOrItemsMap, contentType) {
            console.log('fulfilling task got', path);
            promise.fulfill(status, bodyOrItemsMap, contentType);
          });
        }.bind(this));
            console.log('fulfilling task resume', path);
        this.doTasks();
      }
    },
    corruptServerItemsMap: function(itemsMap, force02) {
      var i;
      if ((typeof(itemsMap) !== 'object') ||
          (Array.isArray(itemsMap))) {
         console.log('not an object', itemsMap);
         return true;
      }
      for (i in itemsMap) {
        if (typeof(itemsMap[i]) !== 'object') {
          console.log('not an object', itemsMap, i);
          return true;
        }
        if(typeof(itemsMap[i].ETag) !== 'string') {
          console.log('ETag not a string', itemsMap, i);
          return true;
        }
        if (i.substr(-1) === '/') {
          if (i.substring(0, i.length-1).indexOf('/') != -1) {
            console.log('multiple slashes in item name', itemsMap, i);
            return true;
          }
        } else {
          if (i.indexOf('/') != -1) {
            console.log('middle slash in item name', itemsMap, i);
            return true;
          }
          if (force02) {
            if (typeof(itemsMap[i]['Content-Type']) !== 'string') {
              console.log('Content-Type not a string', itemsMap, i);
              return true;
            }
            if (typeof(itemsMap[i]['Content-Length']) !== 'number') {
              console.log('Content-Length not a number', itemsMap, i);
              return true;
            }
          }
        }
      }
      return false;
    },
    corruptItemsMap: function(itemsMap) {
      var i;
      if ((typeof(itemsMap) !== 'object') ||
          (Array.isArray(itemsMap))) {
         return true;
      }
      for (i in itemsMap) {
        if (typeof(itemsMap[i]) !== 'boolean') {
          return true;
        }
      }
      return false;
    },
    corruptRevision: function(rev) {
      return ((typeof(rev) !== 'object') ||
          (Array.isArray(rev)) ||
          (rev.revision && typeof(rev.revision) != 'string') ||
          (rev.body && typeof(rev.body) != 'string' && typeof(rev.body) != 'object') ||
          (rev.contentType && typeof(rev.contentType) != 'string') ||
          (rev.contentLength && typeof(rev.contentLength) != 'number') ||
          (rev.timestamp && typeof(rev.timestamp) != 'number') ||
          (rev.itemsMap && this.corruptItemsMap(rev.itemsMap)));
    },
    isCorrupt: function(node) {
      return ((typeof(node) !== 'object') ||
          (Array.isArray(node)) ||
          (typeof(node.path) !== 'string') ||
          (this.corruptRevision(node.common)) ||
          (node.local && this.corruptRevision(node.local)) ||
          (node.remote && this.corruptRevision(node.remote)) ||
          (node.push && this.corruptRevision(node.push)));
    },
    checkDiffs: function() {
      var num = 0;
      return this.local.forAllNodes(function(node) {
        if (num > 100) {
          return;
        }
        if (this.isCorrupt(node, false)) {
          console.log('WARNING: corrupt node in local cache', node);
          //console.log((typeof(node) !== 'object'),
          //  (Array.isArray(node)),
          //  (typeof(node.path) !== 'string'),
          //  (this.corruptRevision(node.common)),
          //  (node.local && this.corruptRevision(node.local)),
          //  (node.remote && this.corruptRevision(node.remote)),
          //  (node.push && this.corruptRevision(node.push)));
          if (typeof(node) === 'object' && node.path) {
            console.log('enqueuing corrupt', node.path);
            this.addTask(node.path);
            num++;
          }
        } else if (this.needsFetch(node)
            && this.access.checkPath(node.path, 'r')) {
          console.log('enqueuing fetch', node.path);
          this.addTask(node.path);
          num++;
        } else if (this.needsPush(node)
            && this.access.checkPath(node.path, 'rw')) {
          console.log('enqueuing push', node.path);
          this.addTask(node.path);
          num++;
        }
      }.bind(this)).then(function() {
        console.log('checkDiffs found', num, this._tasks);
        return num;
      }, function(err) {
        throw err;
      });
    },
    tooOld: function(node) {
      console.log('checking tooOld for', node.path); return true;
      if (node.common) {
        if (!node.common.timestamp) {
          return true;
        }
        return (this.now() - node.common.timestamp > syncInterval);
      }
      return false;
    },
    inConflict: function(node) {
      return (node.local && node.remote && (node.remote.body !== undefined || node.remote.itemsMap));
    },
    needsFetch: function(node) {
      if (this.inConflict(node)) {
        return true;
      }
      if (node.common && node.common.itemsMap === undefined && node.common.body === undefined) {
        return true;
      }
      if (node.remote && node.remote.itemsMap === undefined && node.remote.body === undefined) {
        return true;
      }
    },
    needsPush: function(node) {
      if (this.inConflict(node)) {
        return false;
      }
      if (node.local && !node.push) {
        return true;
      }
    },
    getParentPath: function(path) {
      var parts = path.match(/^(.*\/)([^\/]+\/?)$/);
      if (parts) {
        return parts[1];
      } else {
        throw new Error('not a valid path: "'+path+'"');
      }
    },
    checkRefresh: function() {
      return this.local.forAllNodes(function(node) {
        var parentPath;
        if (this.tooOld(node)) {
          try {
            parentPath = this.getParentPath(node.path);
          } catch(e) {
            console.log('WARNING: can\'t get parentPath of', node.path);
            //node.path is already '/', can't take parentPath
          }
          if (parentPath && this.access.checkPath(parentPath, 'r')) {
            this._tasks[parentPath] = [];
          } else if (this.access.checkPath(node.path, 'r')) {
            this._tasks[node.path] = [];
          }
        }
        console.log('at end of cb', this._tasks);
      }.bind(this)).then(function() {
        console.log('at start of then', this._tasks);
        var i, j;
        console.log('checkRefresh found', this._tasks);
        for(i in this._tasks) {
          nodes = this.local._getInternals()._nodesFromRoot(i);
          for (j=1; j<nodes.length; j++) {
            if (this._tasks[nodes[j]]) {
              delete this._tasks[i];
            }
          }
        }
        console.log('checkRefresh selected', this._tasks);
      }.bind(this), function(err) {
        throw err;
      });
    },
    doTask: function(path) {
      return this.local.getNodes([path]).then(function(objs) {
        console.log('doTask objs', objs);
        if(typeof(objs[path]) === 'undefined') {
          console.log('first fetch');
          //first fetch:
          return {
            action: 'get',
            path: path,
            promise: this.remote.get(path)
          };
        } else if (objs[path].remote && objs[path].remote.revision && !objs[path].remote.itemsMap && !objs[path].remote.body) {
          //fetch known-stale child:
          console.log('known stale');
          return {
            action: 'get',
            path: path,
            promise: this.remote.get(path)
          };
        } else if (objs[path].local && objs[path].local.body) {
          //push put:
          objs[path].push = this.local._getInternals()._deepClone(objs[path].local);
          objs[path].push.timestamp =  this.now();
          return this.local.setNodes(objs).then(function() {
            var options;
            if (objs[path].common.revision) {
              options = {
                ifMatch: objs[path].common.revision
              };
            } else {
              //force this to be an initial PUT (fail if something is already there)
              options = {
                ifNoneMatch: '*'
              };
            }
            console.log('push put');
            return {
              action: 'put',
              path: path,
              promise: this.remote.put(path, objs[path].push.body, objs[path].push.contentType, options)
            };
          }.bind(this));
        } else if (objs[path].local && objs[path].local.body === false) {
          //push delete:
          objs[path].push = { body: false, timestamp: this.now() };
          return this.local.setNodes(objs).then(function() {
            var options;
            if (objs[path].common.revision) {
              options = {
                ifMatch: objs[path].common.revision
              };
            }
            console.log('action is delete');
            return {
              action: 'delete',
              path: path,
              promise: this.remote.delete(path, options)
            };
          }.bind(this));
        } else {
          console.log('refresh');
          //refresh:
          var options = undefined;
          if (objs[path].common.revision) {
            return {
              action: 'get',
              path: path,
              promise: this.remote.get(path, {
                ifMatch: objs[path].common.revision
              })
            };
          } else {
            return {
              action: 'get',
              path: path,
              promise: this.remote.get(path)
            };
          }
        }
      }.bind(this));
    },
    autoMerge: function(obj) {
      console.log('autoMerge', obj);
      var newValue, oldValue;
      if (!obj.remote) {
        return obj;
      }
      if (!obj.local) {
        if (obj.remote) {
          if (obj.path.substr(-1) === '/') {
            newValue = obj.remote.itemsMap;
            oldValue = obj.common.itemsMap;
          } else {
            newValue = (obj.remote.body === false ? undefined : obj.remote.body);
            oldValue = (obj.common.body === false ? undefined : obj.common.body);
          }
          if (newValue) {
            this.local._emit('change', {
              origin: 'remote',
              path: obj.path,
              oldValue: oldValue,
              newValue: newValue
            });
            obj.common = obj.remote;
            delete obj.remote;
          }
        }
        return obj;
      }
      if (obj.path.substr(-1) === '/') {
        //auto merge folder once remote was fetched:
        if (obj.remote.itemsMap) {
          obj.common = obj.remote;
          delete obj.remote;
          if (obj.common.itemsMap) {
            for (i in obj.common.itemsMap) {
              if (!obj.local.itemsMap[i]) {
                //indicates the node is either newly being fetched
                //has been deleted locally (whether or not leading to conflict);
                //before listing it in local listings, check if a local deletion
                //exists.
                obj.local.itemsMap[i] = false;
              }
            }
          }
        }
        return obj;
      } else {
        if (obj.remote.body !== undefined) {
          //revert-or-swallow:
          this.local._emit('change', {
            origin: 'conflict',
            path: obj.path,
            oldValue: obj.local.body,
            newValue: obj.remote.body,
            oldContentType: obj.local.contentType,
            newContentType: obj.remote.contentType
          });
          obj.common = obj.remote;
          delete obj.remote;
          delete obj.local;
        }
        delete obj.push;
        return obj;
      }
    },
    markChildren: function(path, itemsMap, changedObjs) {
      console.log('markChildren', path, itemsMap, changedObjs);
      var i, paths = [], meta = {};
      for (i in itemsMap) {
        paths.push(path+i);
        meta[path+i] = itemsMap[i];
      }
      return this.local.getNodes(paths).then(function(objs) {
        var j, cachingStrategy, create;
        for (j in objs) {
          if (objs[j] && objs[j].common) {
            if (objs[j].common.revision !== meta[j].ETag) {
              if (!objs[j].remote || objs[j].remote.revision !== meta[j].ETag) {
    //            console.log('set remote', j);
                changedObjs[j] = this.local._getInternals()._deepClone(objs[j]);
                changedObjs[j].remote = {
                  revision: meta[j].ETag,
                  timestamp: this.now()
                };
                changedObjs[j] = this.autoMerge(changedObjs[j]);
              }
            }
          } else {
            cachingStrategy = this.caching.checkPath(j);
            if(j.substr(-1) === '/') {
              create = (cachingStrategy === this.caching.SEEN_AND_FOLDERS || cachingStrategy === this.caching.ALL);
            } else {
              create = (cachingStrategy === this.caching.ALL);
            }
            if (create) {
      //        console.log('create', j);
              changedObjs[j] = {
                path: j,
                common: {
                  timestamp: this.now()
                },
                remote: {
                  revision: meta[j].ETag,
                  timestamp: this.now()
                }
              };
            }
          }
          if (changedObjs[j] && meta[j]['Content-Type']) {
            changedObjs[j].remote.contentType = meta[j]['Content-Type'];
          }
          if (changedObjs[j] && meta[j]['Content-Length']) {
            changedObjs[j].remote.contentLength = meta[j]['Content-Length'];
          }       
        }
        return this.local.setNodes(changedObjs);
      }.bind(this));
    },
    completeFetch: function(path, bodyOrItemsMap, contentType, revision) {
      return this.local.getNodes([path]).then(function(objs) {
        var i;
        if(!objs[path]) {
          objs[path] = {
            path: path,
            common: {}
          };
        }
        objs[path].remote = {
          revision: revision,
          timestamp: this.now()
        };
        if (path.substr(-1) === '/') {
          objs[path].remote.itemsMap = {};
          for (i in bodyOrItemsMap) {
            objs[path].remote.itemsMap[i] = true;
          }
        } else {
          objs[path].remote.body = bodyOrItemsMap;
          objs[path].remote.contentType = contentType;
        }
        objs[path] = this.autoMerge(objs[path]);
        console.log('completeFetch after autoMerge', objs);
        return objs;
      }.bind(this));
    },
    completePush: function(path, action, conflict, revision) {
      return this.local.getNodes([path]).then(function(objs) {
        if (conflict) {
          if (!objs[path].remote || objs[path].remote.revision !== revision) {
            objs[path].remote = {
              revision: revision,
              timestamp: this.now()
            };
          }
          objs[path] = this.autoMerge(objs[path]);
        } else {
          objs[path].common = {
            revision: revision,
            timestamp: this.now()
          };
          if (action === 'put') {
            objs[path].common.body = objs[path].push.body;
            objs[path].common.contentType = objs[path].push.contentType;
            if (objs[path].local.body === objs[path].push.body && objs[path].local.contentType === objs[path].push.contentType) {
              delete objs[path].local;
            }
            delete objs[path].push;
          } else if (action === 'delete') {
            if (objs[path].local.body === false) {//successfully deleted and no new local changes since push; flush it.
              objs[path] = undefined;
            } else {
              delete objs[path].push;
            }
          }
        }
        return this.local.setNodes(objs);
      }.bind(this));
    },
    dealWithFailure: function(path, action, statusMeaning) {
      return this.local.getNodes([path]).then(function(objs) {
        if (objs[path]) {
          delete objs[path].push;
          return this.local.setNodes(objs);
        }
      }.bind(this));
    },
    interpretStatus: function(statusCode) {
      var series = Math.floor(statusCode / 100);
      return {
        successful: (series === 2 || statusCode === 304 || statusCode === 412 || statusCode === 404),
        conflict: (statusCode === 412),
        unAuth: (statusCode === 401 || statusCode === 402 ||statusCode === 403),
        notFound: (statusCode === 404)
      }
    },
    handleResponse: function(path, action, status, bodyOrItemsMap, contentType, revision) {
      console.log('handleResponse', path, action, status, bodyOrItemsMap, contentType, revision);
      var statusMeaning = this.interpretStatus(status);
      console.log('status meaning', status, statusMeaning);
      
      if (statusMeaning.successful) {
        if (action === 'get') {
          if (statusMeaning.notFound) {
            if (path.substr(-1) === '/') {
              bodyOrItemsMap = {};
            } else {
              bodyOrItemsmap = false;
            }
          }
          return this.completeFetch(path, bodyOrItemsMap, contentType, revision).then(function(objs) {
          console.log('completeFetch', path, bodyOrItemsMap, contentType, revision);
            if (path.substr(-1) === '/') {
              if (this.corruptServerItemsMap(bodyOrItemsMap)) {
                console.log('WARNING: discarding corrupt folder description from server for ' + path);
                console.log(bodyOrItemsMap);
                breakz();
                return false;
              } else {
                return this.markChildren(path, bodyOrItemsMap, objs).then(function() {
                  return true;//task completed
                });
              }
            } else {
              console.log('setting node after success doc get');
              return this.local.setNodes(objs).then(function() {
                console.log('returning completed: true');
                return true;//task completed
              });
            }
          }.bind(this));
        } else if (action === 'put') {
          return this.completePush(path, action, statusMeaning.conflict, revision).then(function() {
            return true;//task completed
          });
        } else if (action === 'delete') {
          return this.completePush(path, action, statusMeaning.conflict, revision).then(function() {
            return true;//task completed
          });
        } else {
          throw new Error('cannot handle response for unknown action', action);
        }
      } else {
        if (statusMeaning.unAuth) {
          console.log('emitting UnAuth!');
          remoteStorage._emit('error', new RemoteStorage.Unauthorized());
        }
        return this.dealWithFailure(path, action, statusMeaning).then(function() {
          return false;
        });
      }
    },
    numThreads: 1,
    finishTask: function (obj) {
      console.log('got task', obj);
      if(obj.action === undefined) {
        delete this._running[obj.path];
      } else {
        obj.promise.then(function(status, bodyOrItemsMap, contentType, revision) {
          return this.handleResponse(obj.path, obj.action, status, bodyOrItemsMap, contentType, revision);
        }.bind(this)).then(function(completed) {
          console.log('handleResponse success; completed:', completed);
          delete this._timeStarted[obj.path];
          delete this._running[obj.path];
          if (completed) {
            console.log('calling back queued gets for '+obj.path, this._tasks);
            if (this._tasks[obj.path]) {
              for(i=0; i<this._tasks[obj.path].length; i++) {
                this._tasks[obj.path][i]();
              }
              delete this._tasks[obj.path];
            }
          } else {
            console.log('task not completed', this._tasks, this._running);
          }
          console.log('restarting doTasks after success (whether or not completed)');
          console.log('_running/_tasks', this._running, this._tasks);
          if (Object.getOwnPropertyNames(this._tasks).length === 0 || this.stopped) {
            console.log('sync is done!');
            this._emit('done');
          } else {
            console.log('sync is not done!');
            //use a zero timeout to let the JavaScript runtime catch its breath
            //(and hopefully force an IndexedDB auto-commit?):
            setTimeout(function() {
              this.doTasks();
            }.bind(this), 0);
          }
        }.bind(this),
        function(err) {
          console.log('task error', err);
          this.remote.online = false;
          delete this._timeStarted[obj.path];
          delete this._running[obj.path];
          if (!this.stopped) {
            setTimeout(function() {
              console.log('restarting doTasks after failure');
              this.doTasks();
            }.bind(this), 0);
          }
        }.bind(this));
      }
    },
    doTasks: function() {
      console.log('in doTasks');
      var numToHave, numAdded = 0, numToAdd;
      if (this.remote.connected) {
        if (this.remote.online) {
          numToHave = this.numThreads;
        } else {
          numToHave = 1;
        }
      } else {
        numToHave = 0;
      }
      numToAdd = numToHave - Object.getOwnPropertyNames(this._running).length;
      console.log('numToAdd', numToAdd, this._tasks, this._running);
      if (numToAdd <= 0) {
        return true;
      }
      for (path in this._tasks) {
        if (!this._running[path]) {
          console.log('starting', path);
          this._timeStarted = this.now();
          this._running[path] = this.doTask(path);
          this._running[path].then(this.finishTask.bind(this));
          numAdded++;
          if (numAdded >= numToAdd) {
            return true;
          }
        }
      }
      return (numAdded >= numToAdd);
    },
    findTasks: function() {
      return this.checkDiffs().then(function(numDiffs) {
        if (numDiffs) {
          promise = promising();
          promise.fulfill();
          return promise;
        } else {
          return this.checkRefresh();
        }
      }.bind(this), function(err) {
        throw err;
      });
    },
    addTask: function(path, cb) {
      if (!this._tasks[path]) {
        this._tasks[path] = [];
      }
      if (typeof(cb) === 'function') {
        this._tasks[path].push(cb);
      }
    },

    /**
     * Method: sync
     **/
    sync: function() {
      var promise = promising();
      if (!this.doTasks()) {
        return this.findTasks().then(function() {
          try {
            this.doTasks();
          } catch(e) {
            console.log('doTasks error', e);
          }
        }.bind(this), function(err) {
          console.log('sync error', err);
          throw new Error('local cache unavailable');
        });
      } else {
        return promising().fulfill();
      }
    }
  };

  /**
   * Method: getSyncInterval
   *
   * Get the value of the sync interval when application is in the foreground
   *
   * Returns a number of milliseconds
   *
   */
  RemoteStorage.prototype.getSyncInterval = function() {
    return syncInterval;
  };

  /**
   * Method: setSyncInterval
   *
   * Set the value of the sync interval when application is in the foreground
   *
   * Parameters:
   *   interval - sync interval in milliseconds
   *
   */
  RemoteStorage.prototype.setSyncInterval = function(interval) {
    if (typeof(interval) !== 'number') {
      throw interval + " is not a valid sync interval";
    }
    syncInterval = parseInt(interval, 10);
    if (this._syncTimer) {
      this.stopSync();
      this._syncTimer = setTimeout(this.syncCycle.bind(this), interval);
    }
  };

  var SyncError = function(originalError) {
    var msg = 'Sync failed: ';
    if (typeof(originalError) === 'object' && 'message' in originalError) {
      msg += originalError.message;
    } else {
      msg += originalError;
    }
    this.originalError = originalError;
    Error.apply(this, [msg]);
  };

  SyncError.prototype = Object.create(Error.prototype);

  RemoteStorage.SyncError = SyncError;

  RemoteStorage.prototype.syncCycle = function() {
    if (this.sync.stopped) {
      return;
    }  
    this.sync.sync().then(function() {
      this._syncTimer = setTimeout(this.syncCycle.bind(this), this.getSyncInterval());
    }.bind(this),
    function(e) {
      this._syncTimer = setTimeout(this.syncCycle.bind(this), this.getSyncInterval());
    }.bind(this));
  };

  RemoteStorage.prototype.stopSync = function() {
    this.sync.stopped = true;
 };

  var syncCycleCb;
  RemoteStorage.Sync._rs_init = function(remoteStorage) {
    syncCycleCb = function() {
      if(!remoteStorage.sync) {
        //call this now that all other modules are also ready:
        remoteStorage.sync = new RemoteStorage.Sync(
            remoteStorage.local, remoteStorage.remote, remoteStorage.access,
            remoteStorage.caching);
      }  
      remoteStorage.syncCycle();
    };
    remoteStorage.on('ready', syncCycleCb);
  };

  RemoteStorage.Sync._rs_cleanup = function(remoteStorage) {
    remoteStorage.stopSync();
    remoteStorage.removeEventListener('ready', syncCycleCb);
  };

})(typeof(window) !== 'undefined' ? window : global);

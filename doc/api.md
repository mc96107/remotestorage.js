# Defining modules
Start by defining a module (check out the repo to reuse an existing one):

````js
    remoteStorage.defineModule('name', function(privClient, pubCient) {
      //basics:
      privClient.cache(path, strategy); //*** new behavior in 0.10 ***//
      privClient.on('change', function((evt) {}); //*** new behavior in 0.10 ***//
      return {
        exports: {
          storeData: function() {
            privClient.storeObject(ldType, path, obj);
            privClient.storeFile(mimeType, path, arrBuffOrStr);
            privClient.remove(path);
          },
          getData: function() {
            privClient.getListing(path[, maxAge]).then(function(itemsMap) { //*** new behavior in 0.10 ***//
              //itemsMap === { 'a/': {ETag: '123'}}
            });
            privClient.getObject(path[, maxAge]).then(function(obj) { //*** new behavior in 0.10 ***//
              //obj == { '@context': '...', firstName: '...' }
            });
            privClient.getFile(path[, maxAge]).then(function(obj) { //*** new behavior in 0.10 ***//
              //obj = { data: arrBuffOrStr, mimeType: 'application/json'}
            });
            var url = pubClient.getItemURL(path)
          },
          advanced: function() {
            privClient.scope('prefix/')
            privClient.getAll('path/')
          }
        }
      };
    });
````

# Using a module in your app

````js
    remoteStorage.displayWidget()
    remoteStorage.access.claim('name', 'rw');
    remoteStorage.name.func1()...
    remoteStorage[name].func1()...
````

# Custom backends and widgets

````js
    remoteStorage.on('ready', ...)
    remoteStorage.setApiKeys(backend, keys);
    remoteStorage.connect('user@host'[, backend]);
    remoteStorage.disconnect();
    remoteStorage.connected
````

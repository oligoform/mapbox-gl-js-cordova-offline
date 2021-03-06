'use strict';

var util = require('../util/util');
var Evented = require('../util/evented');
var Source = require('./source');
var normalizeURL = require('../util/mapbox').normalizeTileURL;
var Pako = require('pako');

module.exports = VectorTileSource;

function VectorTileSource(options) {
    util.extend(this, util.pick(options, ['url', 'tileSize']));

    if (this.tileSize !== 512) {
        throw new Error('vector tile sources must have a tileSize of 512');
    }

    Source._loadTileJSON.call(this, options);
}

VectorTileSource.prototype = util.inherit(Evented, {
    minzoom: 0,
    maxzoom: 22,
    tileSize: 512,
    reparseOverscaled: true,
    _loaded: false,
    isTileClipped: true,

    onAdd: function(map) {
        this.map = map;
    },

    loaded: function() {
        return this._pyramid && this._pyramid.loaded();
    },

    update: function(transform) {
        if (this._pyramid) {
            this._pyramid.update(this.used, transform);
        }
    },

    reload: function() {
        if (this._pyramid) {
            this._pyramid.reload();
        }
    },

    getVisibleCoordinates: Source._getVisibleCoordinates,
    getTile: Source._getTile,

    featuresAt: Source._vectorFeaturesAt,
    featuresIn: Source._vectorFeaturesIn,

    _loadTile: function(tile) {
        var overscaling = tile.coord.z > this.maxzoom ? Math.pow(2, tile.coord.z - this.maxzoom) : 1;
        var params = {
            url: normalizeURL(tile.coord.url(this.tiles, this.maxzoom), this.url),
            uid: tile.uid,
            coord: tile.coord,
            zoom: tile.coord.z,
            tileSize: this.tileSize * overscaling,
            source: this.id,
            overscaling: overscaling,
            angle: this.map.transform.angle,
            pitch: this.map.transform.pitch,
            collisionDebug: this.map.collisionDebug
        };

        if (tile.workerID) {
            this.dispatcher.send('reload tile', params, this._tileLoaded.bind(this, tile), tile.workerID);
        } else {
            var url = params.url.split('/'),
                z = url[0],
                x = url[1],
                y = url[2];
            y = (1 << z) - 1 - y;

            if (!this.db) {
                this.db = window.sqlitePlugin.openDatabase({
                    name: params.source + '.mbtiles',
                    location: 2,
                    createFromLocation: 1
                });
            }

            this.db.transaction(function(tx) {
                tx.executeSql('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?', [z, x, y], function(tx, res) {
                    var tileData = res.rows.item(0).tile_data,
                        tileDataDecoded = window.atob(tileData),
                        tileDataDecodedLength = tileDataDecoded.length,
                        tileDataTypedArray = new Uint8Array(tileDataDecodedLength);
                    for (var i = 0; i < tileDataDecodedLength; ++i) {
                        tileDataTypedArray[i] = tileDataDecoded.charCodeAt(i);
                    }
                    var tileDataInflated = Pako.inflate(tileDataTypedArray);
                    params.tileData = tileDataInflated;
                    tile.workerID = this.dispatcher.send('load tile', params, this._tileLoaded.bind(this, tile));
                }.bind(this), function(tx, e) {
                    console.log('Database Error: ' + e.message);
                });
            }.bind(this));
        }
    },

    _tileLoaded: function(tile, err, data) {
        if (tile.aborted)
            return;

        if (err) {
            this.fire('tile.error', {tile: tile, error: err});
            return;
        }

        tile.loadVectorData(data);

        if (tile.redoWhenDone) {
            tile.redoWhenDone = false;
            tile.redoPlacement(this);
        }

        this.fire('tile.load', {tile: tile});
        this.fire('tile.stats', data.bucketStats);
    },

    _abortTile: function(tile) {
        tile.aborted = true;
        this.dispatcher.send('abort tile', { uid: tile.uid, source: this.id }, null, tile.workerID);
    },

    _addTile: function(tile) {
        this.fire('tile.add', {tile: tile});
    },

    _removeTile: function(tile) {
        this.fire('tile.remove', {tile: tile});
    },

    _unloadTile: function(tile) {
        tile.unloadVectorData(this.map.painter);
        this.dispatcher.send('remove tile', { uid: tile.uid, source: this.id }, null, tile.workerID);
    },

    redoPlacement: Source.redoPlacement,

    _redoTilePlacement: function(tile) {
        tile.redoPlacement(this);
    }
});

/*
 *   Copyright (c) 2015 Particle Industries, Inc.  All rights reserved.
 *
 *   This program is free software; you can redistribute it and/or
 *   modify it under the terms of the GNU Lesser General Public
 *   License as published by the Free Software Foundation, either
 *   version 3 of the License, or (at your option) any later version.
 *
 *   This program is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 *   Lesser General Public License for more details.
 *
 *   You should have received a copy of the GNU Lesser General Public
 *   License along with this program; if not, see <http://www.gnu.org/licenses/>.
 */

var settings = require('../settings.js');
var CryptoLib = require('../lib/ICrypto.js');
var SparkCore = require('../clients/SparkCore.js');
var EventPublisher = require('../lib/EventPublisher.js');
var utilities = require('../lib/utilities.js');
var logger = require('../lib/logger.js');
var model = require("../lib/Model.js");
var memo = require("../lib/Memory.js");
var rc = require("../lib/Redis.js").InitRedisClient();
var crypto = require('crypto');
var ursa = require('ursa');
var when = require('when');
var path = require('path');
var net = require('net');
var fs = require('fs');
var moment = require('moment');


var DeviceServer = function(options) {
    this.options = options;
    this.options = options || {};
    settings.coreKeysDir = this.options.coreKeysDir = this.options.coreKeysDir || settings.coreKeysDir;

    memo._allCoresByID = {};
    memo._attribsByID = {};
    memo._allIDs = {};

    this.init();
};

DeviceServer.prototype = {

    init: function() {
        this.loadCoreData();
    },

    addCoreKey: function(coreid, public_key) {
        model.saveCoreKey({
            core_id: coreid,
            public_key: public_key
        });
        return false;
    },

    saveCoreData: function(coreid) {
        var defer = when.defer();
        try {
            var attribs = memo._attribsByID[coreid];
            var that = this;

            model.saveCore(attribs).then(function(result) {
                setTimeout(function() {
                    that.loadCore(coreid);
                }, 2000);
                defer.resolve();
            }, function(err) {
                if (err.code && err.code == "ER_DUP_ENTRY") {
                    logger.log("coreid already exist.");
                } else {
                    logger.error("Save core error: ", err);
                }
                defer.reject();
            });
        } catch (ex) {
            logger.error("Error saving core data ", ex);
        }

        return defer.promise;
    },

    loadCoreData: function() {
        var attribsByID = {};

        model.allCore().then(function(result) {
            for (var i in result) {
                var core = result[i];
                core.coreID = core.core_id;
                attribsByID[core.coreID] = core;
                memo._allIDs[core.coreID] = true;
            }
            memo._attribsByID = attribsByID;
        }, function(err) {
            logger.error("Get AllCore Error: ", err);
        });
    },

    loadCore: function(coreid) {
        model.findCore(coreid).then(function(result) {
            var core = result[0];
            core.coreID = core.core_id;
            memo._allIDs[core.coreID] = true;
            memo._attribsByID[core.coreID] = core;
        });
    },

    getCore: function(coreid) {
        return memo._allCoresByID[coreid];
    },

    getCoreAttributes: function(coreid) {
        memo._attribsByID[coreid] = memo._attribsByID[coreid] || {};
        return memo._attribsByID[coreid];
    },

    setCoreAttribute: function(coreid, name, value) {
        memo.setAttribute(coreid, name, value);
        this.saveCoreData(coreid);
        return true;
    },

    setCoreAttributes: function(coreid, objects, callback) {
        memo.setAttributes(coreid, objects);
        this.saveCoreData(coreid).then(function() {
            if (callback) callback();
        });
        return;
    },

    getCoreByName: function(name) {
        //var cores = this._allCoresByID;
        var cores = memo._attribsByID;
        for (var coreid in cores) {
            var attribs = cores[coreid];
            if (attribs && (attribs.name == name)) {
                return memo._allCoresByID[coreid];
            }
        }
        return null;
    },

    /**
     * return all the cores we know exist
     * @returns {null}
     */
    getAllCoreIDs: function() {
        return memo._allIDs;
    },

    /**
     * return all the cores that are connected
     * @returns {null}
     */
    getAllCores: function() {
        return memo._allCoresByID;
    },

    /**
     * return one core's claim_code and compare them
     * @returns {promise}
     */
    compareClaimCode: function(coreid, claim_code) {
        var defer = when.defer();

        model.findCoreKey(coreid).then(function(result) {
            if (result.length > 0 && result[0].claim_code == claim_code) {
                defer.resolve();
            } else {
                defer.reject("fail");
            }
        }, function(err) {
            defer.reject({
                error: err
            });
        });

        return defer.promise;
    },


    //id: core.coreID,
    //name: core.name || null,
    //last_app: core.last_flashed_app_name || null,
    //last_heard: null


    start: function() {
        global.settings = settings;
        global.redis = rc;

        //
        //  Create our basic socket handler
        //

        var that = this,
            connId = 0,
            _cores = {},
            server = net.createServer(function(socket) {
                process.nextTick(function() {
                    try {
                        var key = "_" + connId++;
                        logger.log("Connection from: " + socket.remoteAddress + ", connId: " + connId);

                        var core = new SparkCore();
                        core.socket = socket;
                        core.startupProtocol();
                        core._connection_key = key;

                        //TODO: expose to API
                        core.on('ready', function() {
                            var coreid = this.getHexCoreID();
                            logger.log("Core " + coreid + " online!");
                            memo._allCoresByID[coreid] = core;
                            memo._attribsByID[coreid] = memo._attribsByID[coreid] || {
                                coreID: coreid,
                                name: null,
                                ip: this.getRemoteIPAddress(),
                                product_id: this.spark_product_id,
                                firmware_version: this.product_firmware_version,
                                group_id: 0
                            };

                            if (memo._attribsByID[coreid].firmware_version == null ||
                                memo._attribsByID[coreid].firmware_version == "") {
                                that.setCoreAttribute(coreid, "firmware_version", this.product_firmware_version);
                            }

                            if (global.publisher) {
                                global.redis.hset(coreid, "online");
                                global.publisher.publish(
                                    true,
                                    "spark/status",
                                    undefined,
                                    "online",
                                    60,
                                    moment().toISOString(),
                                    coreid
                                );
                            }
                        });
                        core.on('disconnect', function(msg) {
                            var coreid = this.getHexCoreID();

                            if (memo._allCoresByID[coreid] == core) {
                                logger.log("Core offline:" + coreid);
                                delete memo._allCoresByID[coreid];

                                if (global.publisher) {
                                    global.redis.hset(coreid, "offline");
                                    global.publisher.publish(
                                        true,
                                        "spark/status",
                                        undefined,
                                        "offline",
                                        60,
                                        moment().toISOString(),
                                        coreid
                                    );
                                }
                            }
                        });
                    } catch (ex) {
                        logger.error("core startup failed " + ex);
                    }
                });
            });

        global.publisher = new EventPublisher();

        server.on('error', function() {
            logger.error("something blew up ", arguments);
        });


        //
        //  Load the provided key, or generate one
        //
        if (!fs.existsSync(settings.serverKeyFile)) {
            console.warn("Creating NEW server key");
            var keys = ursa.generatePrivateKey();


            var extIdx = settings.serverKeyFile.lastIndexOf(".");
            var derFilename = settings.serverKeyFile.substring(0, extIdx) + ".der";
            var pubPemFilename = settings.serverKeyFile.substring(0, extIdx) + ".pub.pem";

            fs.writeFileSync(settings.serverKeyFile, keys.toPrivatePem('binary'));
            fs.writeFileSync(pubPemFilename, keys.toPublicPem('binary'));

            //DER FORMATTED KEY for the core hardware
            //TODO: fs.writeFileSync(derFilename, keys.toPrivatePem('binary'));
        }


        //
        //  Load our server key
        //
        CryptoLib.loadServerKeys(
            settings.serverKeyFile,
            settings.serverKeyPassFile,
            settings.serverKeyPassEnvVar
        );

        //
        //  Wait for the keys to be ready, then start accepting connections
        //
        server.listen(settings.PORT, function() {
            logger.log("SOAP started", {
                host: settings.HOST,
                port: settings.PORT
            });
        });


    }

};
module.exports = DeviceServer;

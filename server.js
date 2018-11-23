#!/usr/bin/env node

'use strict';

process.title = 'multiparty-meeting-sipgw';

const config = require('config');
const Srf = require('drachtio-srf');
// const RtpEngine = require('rtpengine-client').Client;
const Logger = require('./lib/Logger');
const Room = require('./lib/Room');

const srfConfig = config.get('Srf');
// const rtpEngineConfig = config.get('rtpengine');

const logger = new Logger();

// Drachtio connection
const srf = new Srf();

// RtpEngine connection
const rtpEngine = null; // new RtpEngine(rtpEngineConfig.localport);

srf.connect(srfConfig);

srf.on('connect', (err, hostport) =>
{
	logger.info('Connected to a drachtio server listening on: %s', hostport);
})
	.on('error', (err) =>
	{
		logger.error('Error connecting to drachtio server: %s', err);
	});

srf.invite((req, res) =>
{
	Promise.resolve()
		.then(() =>
		{
			const roomUri = req.getParsedHeader('to').uri.match(/sip:(.*?)@(.*?)$/);

			const roomName = roomUri[1];

			if (roomName)
			{
				logger.info(
					'invite request [roomName:"%s"]', roomName);

				const room = new Room(roomName, srf, rtpEngine);

				room.on('close', () =>
				{
					logger.debug(
						'close() [roomName:"%s"]', roomName);
				});

				room.handleCall(req, res);
			}
			else
			{
				res.send(400);
			}
		})
		.catch((error) =>
		{
			logger.error('Error on invite: %s', error);

			res.send(500);
		});
});

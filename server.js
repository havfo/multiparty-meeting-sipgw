#!/usr/bin/env node

'use strict';

process.title = 'multiparty-meeting-sipgw';

const config = require('config');
const Srf = require('drachtio-srf');
const Logger = require('./lib/Logger');
const Room = require('./lib/Room');
const kurento = require('kurento-client');

const kurentoConfig = config.get('Kurento');
const srfConfig = config.get('Drachtio');

const logger = new Logger();

let _kurentoClient = null;

// Drachtio connection
const srf = new Srf();

srf.connect(srfConfig);

srf.on('connect', (err, hostport) =>
{
	logger.info('Connected to a drachtio server listening on: %s', hostport);
})
	.on('error', (err) =>
	{
		logger.error('Error connecting to drachtio server: %s', err);
	});

srf.options((req, res) =>
{
	res.send(200);
});

srf.invite(async (req, res) =>
{
	const kurentoClient = await _getKurentoClient();

	try
	{
		const roomUri = req.getParsedHeader('to').uri.match(/sip:(.*?)@(.*?)$/);

		const roomName = roomUri[1];

		const fromHeader = req.get('from').match(/"(.+?)" <sip:.*>|<sip:(.*?)>/);

		let displayName;
		if (fromHeader[1])
			displayName = fromHeader[1];
		else
			displayName = fromHeader[2];

		if (roomName)
		{
			logger.info(
				'invite request [roomName:"%s"]', roomName);

			const room = new Room(roomName, srf, kurentoClient, displayName);

			room.on('close', () =>
			{
				logger.debug(
					'close() [roomName:"%s"]', roomName);
			});

			await room.handleCall(req, res);
		}
		else
		{
			res.send(400);
		}
	}
	catch (error)
	{
		logger.error('Error on invite: %s', error);

		res.send(500);
	}
});

async function _getKurentoClient()
{
	logger.debug('_getKurentoClient()');

	return new Promise((resolve, reject) =>
	{
		if (_kurentoClient !== null)
		{
			logger.info('_getKurentoClient | KurentoClient already created');

			return resolve(_kurentoClient);
		}

		kurento(kurentoConfig.uri, (error, kurentoClient) =>
		{
			if (error)
			{
				logger.error(error);

				return reject(error);
			}

			logger.info(`_getKurentoClient | created KurentoClient, connected to: ${kurentoConfig.uri}`);

			_kurentoClient = kurentoClient;

			return resolve(_kurentoClient);
		});
	});
}

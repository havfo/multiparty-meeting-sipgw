const config = require('config');
const EventEmitter = require('events').EventEmitter;
const Srf = require('drachtio-srf');
const mediasoupClient = require('mediasoup-client');
const io = require('socket.io-client');
const MediaStreamTrack = require('node-mediastreamtrack');
const kurento = require('kurento-client');
const randomString = require('random-string');
const KurentoHandler = require('./KurentoHandler');
const Logger = require('./Logger');
const Spotlights = require('./Spotlights');
const kurentoConfig = config.get('Kurento');
const mediasoupConfig = config.get('Mediasoup');
const roomConfig = config.get('Room');

const logger = new Logger('Room');

mediasoupClient.setDeviceHandler(KurentoHandler, {
	flag : 'kurento',
	name : 'Kurento'
});

class Room extends EventEmitter
{
	constructor(roomId, srf)
	{
		logger.info('constructor() [roomId:"%s"]', roomId);

		super();
		this.setMaxListeners(Infinity);

		// Room ID
		this._roomId = roomId;

		// Peername in room
		this._peerName = randomString({ length: 8 }).toLowerCase();

		// Multiparty-meeting room
		this._room = new mediasoupClient.Room(mediasoupConfig);
		this._room.roomId = roomId;

		this._spotlights = new Spotlights(roomConfig.maxSpotlights, this._room);

		// Receive transports to multiparty-meeting room
		this._recvTransports = {};

		// Audio send transports to multiparty-meeting room
		this._audioSendTransport = null;

		// Video send transport to multiparty-meeting room
		this._videoSendTransport = null;

		// SIP client audio producer
		this._audioProducer = null;

		// SIP client video producer
		this._videoProducer = null;

		// Peer display name
		this._displayName = 'SIP caller';

		// This device
		this._device = {
			flag    : 'sipendpoint',
			name    : 'SIP Endpoint',
			version : undefined
		};

		// Kurento client instance
		this._kurentoClient = null;

		// Kurento Mediapipeline
		this._pipeline = null;

		// Kurento Composite node
		this._composite = null;

		// Kurento SIP RtpEndpoint
		this._sipEndpoint = null;

		// Kurento SIP HubPort
		this._sipHubPort = null;

		// Kurento audio producer RtpEndpoint
		this._audioProducerEndpoint = null;

		// Kurento video producer RtpEndpoint
		this._videoProducerEndpoint = null;

		// Object containing corresponding Endpoint and HubPort mapped by consumer.id
		this._consumerEndpoints = {};

		// Socket.io signaling socket
		this._signalingSocket = null;

		// Drachtio instance
		this._srf = srf;

		// Closed flag.
		this._closed = false;

		// The associated SIP dialog
		this._dialog = null;
	}

	get id()
	{
		return this._roomId;
	}

	close()
	{
		if (this._closed)
			return;

		this._closed = true;

		// Leave the mediasoup Room.
		this._room.leave();

		// Close signaling Peer (wait a bit so mediasoup-client can send
		// the 'leaveRoom' notification).
		setTimeout(() =>
		{
			if (this._signalingSocket)
				this._signalingSocket.close();
		}, 250);

		Object.keys(this._consumerEndpoints).forEach((key) =>
		{
			const { rtpEndpoint, hubPort } = this._consumerEndpoints[key];

			if (rtpEndpoint)
				rtpEndpoint.release();

			if (hubPort)
				hubPort.release();
		});

		if (this._sipHubPort)
			this._sipHubPort.release();

		if (this._sipEndpoint)
			this._sipEndpoint.release();

		if (this.composite)
			this._composite.release();

		if (this._pipeline)
			this._pipeline.release();

		if (this._kurentoClient)
			this._kurentoClient.close();

		logger.debug('close()');

		// Emit close to delete this instance of Room
		// wait for things to finish
		setTimeout(() => this.emit('close'), 1000);
	}

	// Nothing starts until we get a call
	// Join multiparty-meeting when dialog is created
	async handleCall(req, res)
	{
		logger.info('handleCall() [req:"%s", res:"%s"]', req, res);

		try
		{
			this._sipHubPort = await this._createHubPort();
			const sipEndpoint = await this._getSipEndpoint();

			// Media flow: hubPort -------> sipEndpoint
			await this._connectMediaElements(this._sipHubPort, sipEndpoint);

			this._dialog = await this._srf.createUAS(req, res, {
				localSdp : await this._processSipEndpointSdp(req.body),
				headers  : {
					'User-Agent' : 'multiparty-meeting-sipgw'
				}
			});

			this._dialog.on('destroy', () =>
			{
				logger.debug('Caller hung up');

				this.close();
			});

			logger.info('Dialog created');

			this._join({
				displayName : this._displayName,
				device      : this._device
			});
		}
		catch (error)
		{
			if (error instanceof Srf.SipError && error.status === 487)
			{
				logger.debug('Call canceled by caller');
			}

			this.close();
		}
	}

	_join({ displayName, device })
	{
		logger.debug('_join()');

		this._signalingSocket = io.connect(
			roomConfig.socketUrl,
			{
				query : {
					peerName : this._peerName,
					roomId   : this._roomId
				},
				rejectUnauthorized : false,
				secure             : true,
				transport          : [ 'websocket' ],
				forceNew           : true
			}
		);

		this._signalingSocket.on('connect', () =>
		{
			logger.debug('signaling Peer "connect" event');

			this._joinRoom({ displayName, device });
		});

		this._signalingSocket.on('disconnect', () =>
		{
			logger.warn('signaling Peer "disconnect" event');

			try { this._room.remoteClose({ cause: 'signaling disconnected' }); }
			catch (error) {}
		});

		this._signalingSocket.on('close', () =>
		{
			if (this._closed)
				return;

			logger.warn('signaling Peer "close" event');

			this.close();
		});

		this._signalingSocket.on('mediasoup-notification', (data) =>
		{
			const notification = data;

			this._room.receiveNotification(notification);
		});

		this._signalingSocket.on('active-speaker', (data) =>
		{
			const { peerName } = data;

			if (peerName && peerName !== this._peerName)
				this._spotlights.handleActiveSpeaker(peerName);
		});

		this._signalingSocket.on('display-name-changed', (data) =>
		{
			// eslint-disable-next-line no-shadow
			const { peerName, displayName } = data;

			// NOTE: Hack, we shouldn't do this, but this is just a demo.
			const peer = this._room.getPeerByName(peerName);

			if (!peer)
			{
				logger.error('peer not found');

				return;
			}

			peer.appData.displayName = displayName;
		});
	}

	async _joinRoom({ displayName, device })
	{
		logger.debug('_joinRoom()');

		// NOTE: We allow rejoining (room.join()) the same mediasoup Room when
		// WebSocket re-connects, so we must clean existing event listeners. Otherwise
		// they will be called twice after the reconnection.
		this._room.removeAllListeners();

		this._room.on('close', (originator, appData) =>
		{
			if (originator === 'remote')
			{
				logger.warn('mediasoup Peer/Room remotely closed [appData:%o]', appData);

				return;
			}
		});

		this._room.on('request', (request, callback, errback) =>
		{
			logger.debug(
				'sending mediasoup request [method:%s]:%o', request.method, request);

			this._sendRequest('mediasoup-request', request)
				.then(callback)
				.catch(errback);
		});

		this._room.on('notify', (notification) =>
		{
			logger.debug(
				'sending mediasoup notification [method:%s]:%o',
				notification.method, notification);

			this._sendRequest('mediasoup-notification', notification)
				.catch((error) =>
				{
					logger.warn('could not send mediasoup notification:%o', error);
				});
		});

		this._room.on('newpeer', (peer) =>
		{
			logger.debug(
				'room "newpeer" event [name:"%s", peer:%o]', peer.name, peer);

			this._handlePeer(peer);
		});

		try
		{
			await this._room.join(this._peerName, { displayName, device });

			this._audioSendTransport =
				this._room.createTransport('send', { media: 'SEND_AUDIO' });

			this._audioSendTransport.on('close', (originator) =>
			{
				logger.debug(
					'Transport "close" event [originator:%s]', originator);
			});

			this._videoSendTransport =
				this._room.createTransport('send', { media: 'SEND_VIDEO' });

			this._videoSendTransport.on('close', (originator) =>
			{
				logger.debug(
					'Transport "close" event [originator:%s]', originator);
			});

			await this._enableAudioProducer();
			await this._enableVideoProducer();

			await this._getServerHistory();

			this._spotlights.on('spotlights-updated', (spotlights) =>
			{
				logger.debug('Spotlights updated [spotlights:%o]', spotlights);

				// this._updateSpotlights(spotlights);
			});

			const peers = this._room.peers;

			for (const peer of peers)
			{
				this._handlePeer(peer);
			}

			this._spotlights.start();
		}
		catch (error)
		{
			logger.error('_joinRoom() failed:%o', error);

			this.close();
		}
	}

	async _updateSpotlights(spotlights)
	{
		logger.debug('_updateSpotlights()');

		try
		{
			for (const peer of this._room.peers)
			{
				if (spotlights.indexOf(peer.name) > -1) // Resume video for speaker
				{
					for (const consumer of peer.consumers)
					{
						if (consumer.kind !== 'video' || !consumer.supported)
							continue;

						consumer.resume();

						if (consumer.locallyPaused)
						{
							const { rtpEndpoint } = this._consumerEndpoints[consumer.id];

							const hubPort = await this._createHubPort();

							this._consumerEndpoints[consumer.id].hubPort = hubPort;

							// Media flow: rtpEndpoint -------> hubPort
							await this._connectMediaElements(
								rtpEndpoint, hubPort, consumer.kind.toUpperCase()
							);
						}
					}
				}
				else // Pause video for everybody else
				{
					for (const consumer of peer.consumers)
					{
						if (consumer.kind !== 'video')
							continue;

						consumer.pause('not-speaker');

						if (!consumer.locallyPaused)
						{
							const { rtpEndpoint, hubPort } = this._consumerEndpoints[consumer.id];

							await this._disconnectMediaElements(rtpEndpoint, hubPort);
							hubPort.release();
						}
					}
				}
			}
		}
		catch (error)
		{
			logger.error('_updateSpotlights() failed: %o', error);
		}
	}

	async _getServerHistory()
	{
		logger.debug('getServerHistory()');

		try
		{
			const {
				lastN
			} = await this._sendRequest('server-history');

			if (lastN.length > 0)
			{
				logger.debug('Got lastN');

				// Remove our self from list
				const index = lastN.indexOf(this._peerName);

				lastN.splice(index, 1);

				this._spotlights.addSpeakerList(lastN);
			}
		}
		catch (error)
		{
			logger.error('getServerHistory() | failed: %o', error);
		}
	}

	_timeoutCallback(callback)
	{
		let called = false;

		const interval = setTimeout(
			() =>
			{
				if (called)
					return;

				called = true;

				callback(new Error('Request timeout.'));
			},
			mediasoupConfig.requestTimeout
		);

		return (...args) =>
		{
			if (called)
				return;
			called = true;
			clearTimeout(interval);

			callback(...args);
		};
	}

	_sendRequest(method, data)
	{
		return new Promise((resolve, reject) =>
		{
			if (!this._signalingSocket)
			{
				reject('No socket connection.');
			}
			else
			{
				this._signalingSocket.emit(method, data, this._timeoutCallback((err, response) =>
				{
					if (err)
					{
						reject(err);
					}
					else
					{
						resolve(response);
					}
				}));
			}
		});
	}

	async _enableAudioProducer()
	{
		logger.debug('_enableAudioProducer()');

		try
		{
			const audioTrack = new MediaStreamTrack({ kind: 'audio' });

			this._audioProducer = this._room.createProducer(
				audioTrack, { simulcast: false }, { source: 'mic' });

			const endpoint = await this._createRtpEndpoint();

			const sipEndpoint = await this._getSipEndpoint();

			await this._connectMediaElements(sipEndpoint, endpoint, 'AUDIO');

			this._audioProducerEndpoint = endpoint;
			this._audioProducer.endpoint = this._audioProducerEndpoint;

			audioTrack.stop();

			await this._audioProducer.send(this._audioSendTransport);

			this._audioProducer.on('close', (originator) =>
			{
				logger.debug(
					'audio Producer "close" event [originator:%s]', originator);

				this._audioProducer = null;
			});

			this._audioProducer.on('pause', (originator) =>
			{
				logger.debug(
					'audio Producer "pause" event [originator:%s]', originator);
			});

			this._audioProducer.on('resume', (originator) =>
			{
				logger.debug(
					'audio Producer "resume" event [originator:%s]', originator);
			});

			this._audioProducer.on('handled', () =>
			{
				logger.debug('audio Producer "handled" event');
			});

			this._audioProducer.on('unhandled', () =>
			{
				logger.debug('audio Producer "unhandled" event');
			});
		}
		catch (error)
		{
			logger.error('_enableAudioProducer() failed:%o', error);

			if (this._audioProducer)
				this._audioProducer.close();

			throw error;
		}
	}

	async _enableVideoProducer()
	{
		logger.debug('_enableVideoProducer()');

		try
		{
			const videoTrack = new MediaStreamTrack({ kind: 'video' });

			this._videoProducer = this._room.createProducer(
				videoTrack, { simulcast: false }, { source: 'webcam' });

			const endpoint = await this._createRtpEndpoint();

			const sipEndpoint = await this._getSipEndpoint();

			await this._connectMediaElements(sipEndpoint, endpoint, 'VIDEO');

			this._videoProducerEndpoint = endpoint;
			this._videoProducer.endpoint = this._videoProducerEndpoint;

			videoTrack.stop();

			await this._videoProducer.send(this._videoSendTransport);

			this._videoProducer.on('close', (originator) =>
			{
				logger.debug(
					'video Producer "close" event [originator:%s]', originator);

				this._videoProducer = null;
			});

			this._videoProducer.on('pause', (originator) =>
			{
				logger.debug(
					'video Producer "pause" event [originator:%s]', originator);
			});

			this._videoProducer.on('resume', (originator) =>
			{
				logger.debug(
					'video Producer "resume" event [originator:%s]', originator);
			});

			this._videoProducer.on('handled', () =>
			{
				logger.debug('video Producer "handled" event');
			});

			this._videoProducer.on('unhandled', () =>
			{
				logger.debug('video Producer "unhandled" event');
			});
		}
		catch (error)
		{
			logger.error('_enableVideoProducer() failed:%o', error);

			if (this._videoProducer)
				this._videoProducer.close();

			throw error;
		}
	}

	_handlePeer(peer)
	{
		logger.debug('_handlePeer()');

		for (const consumer of peer.consumers)
		{
			this._handleConsumer(consumer);
		}

		peer.on('close', (originator) =>
		{
			logger.debug(
				'peer "close" event [name:"%s", originator:%s]',
				peer.name, originator);
		});

		peer.on('newconsumer', (consumer) =>
		{
			logger.debug(
				'peer "newconsumer" event [name:"%s", id:%s, consumer:%o]',
				peer.name, consumer.id, consumer);

			this._handleConsumer(consumer);
		});
	}

	_handleConsumer(consumer)
	{
		logger.debug('_handleConsumer()');

		consumer.on('close', (originator) =>
		{
			logger.debug(
				'consumer "close" event [id:%s, originator:%s, consumer:%o]',
				consumer.id, originator, consumer);
			const { rtpEndpoint, hubPort } = this._consumerEndpoints[consumer.id];

			if (hubPort)
				hubPort.release();

			if (rtpEndpoint)
				rtpEndpoint.release();

			delete this._consumerEndpoints[consumer.id];

			if (this._recvTransports[consumer.id])
				this._recvTransports[consumer.id].close();

			delete this._recvTransports[consumer.id];
		});

		consumer.on('handled', (originator) =>
		{
			logger.debug(
				'consumer "handled" event [id:%s, originator:%s, consumer:%o]',
				consumer.id, originator, consumer);
		});

		consumer.on('pause', (originator) =>
		{
			logger.debug(
				'consumer "pause" event [id:%s, originator:%s, consumer:%o]',
				consumer.id, originator, consumer);
		});

		consumer.on('resume', (originator) =>
		{
			logger.debug(
				'consumer "resume" event [id:%s, originator:%s, consumer:%o]',
				consumer.id, originator, consumer);
		});

		consumer.on('effectiveprofilechange', (profile) =>
		{
			logger.debug(
				'consumer "effectiveprofilechange" event [id:%s, consumer:%o, profile:%s]',
				consumer.id, consumer, profile);
		});

		// Receive the consumer (if we can).
		if (consumer.supported)
		{
			const transport = this._room.createTransport('recv', { media: 'RECV' });

			transport.on('close', (originator) =>
			{
				logger.debug(
					'receiving Transport "close" event [originator:%s]', originator);
			});

			this._recvTransports[consumer.id] = transport;

			let rtpEndpoint;
			let hubPort;

			Promise.resolve()
				.then(() =>
				{
					return this._createRtpEndpoint();
				})
				.then((endpoint) =>
				{
					rtpEndpoint = endpoint;

					return this._createHubPort();
				})
				.then((port) =>
				{
					hubPort = port;

					this._consumerEndpoints[consumer.id] = {
						rtpEndpoint,
						hubPort
					};

					consumer.endpoint = rtpEndpoint;

					// Media flow: rtpEndpoint -------> hubPort
					return this._connectMediaElements(
						rtpEndpoint, hubPort, consumer.kind.toUpperCase()
					);
				})
				.then(() =>
				{
					return consumer.receive(this._recvTransports[consumer.id]);
				})
				.catch((error) =>
				{
					logger.error(
						'unexpected error while receiving a new Consumer:%o', error);
				});
		}
	}

	async _getKurentoClient()
	{
		logger.debug('_getKurentoClient()');

		return new Promise((resolve, reject) =>
		{
			if (this._kurentoClient !== null)
			{
				logger.info('KurentoClient already created');

				return resolve(this._kurentoClient);
			}

			kurento(kurentoConfig.uri, (error, kurentoClient) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created KurentoClient, connected to: ${kurentoConfig.uri}`);

				this._kurentoClient = kurentoClient;

				return resolve(this._kurentoClient);
			});
		});
	}

	async _getPipeline()
	{
		logger.debug('_getPipeline()');

		const kurentoClient = await this._getKurentoClient();

		return new Promise((resolve, reject) =>
		{
			if (this._pipeline !== null)
			{
				logger.info('Pipeline already created');

				return resolve(this._pipeline);
			}

			kurentoClient.create('MediaPipeline', (error, pipeline) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created MediaPipeline for room: ${this._roomId}`);

				this._pipeline = pipeline;

				return resolve(this._pipeline);
			});
		});
	}

	async _getComposite()
	{
		logger.debug('_getComposite()');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			if (this._composite !== null)
			{
				logger.info('Composite already created');

				return resolve(this._composite);
			}

			pipeline.create('Composite', (error, composite) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created Composite for room: ${this._roomId}`);

				this._composite = composite;

				return resolve(this._composite);
			});
		});
	}

	async _getSipEndpoint()
	{
		logger.debug('_getSipEndpoint()');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			if (this._sipEndpoint !== null)
			{
				logger.info('SipEndpoint already created');

				return resolve(this._sipEndpoint);
			}

			pipeline.create('RtpEndpoint', (error, sipEndpoint) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created SipEndpoint for room: ${this._roomId}`);

				this._sipEndpoint = sipEndpoint;

				return resolve(this._sipEndpoint);
			});
		});
	}

	async _connectMediaElements(fromElement, toElement, options)
	{
		logger.debug(
			'_connectMediaElements() [fromElement:"%o", toElement:"%o"]',
			fromElement, toElement
		);

		return new Promise((resolve, reject) =>
		{
			fromElement.connect(toElement, options, (error) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('Successfully connected endpoints');

				return resolve();
			});
		});
	}

	async _disconnectMediaElements(fromElement, toElement)
	{
		logger.debug(
			'_disconnectMediaElements() [fromElement:"%o", toElement:"%o"]',
			fromElement, toElement
		);

		return new Promise((resolve, reject) =>
		{
			fromElement.disconnect(toElement, (error) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('Successfully disconnected endpoints');

				return resolve();
			});
		});
	}

	async _processSipEndpointSdp(offer)
	{
		logger.debug('_processSipEndpointSdp() [offer:"%s"]', offer);

		const sipEndpoint = await this._getSipEndpoint();

		return new Promise((resolve, reject) =>
		{
			sipEndpoint.processOffer(offer, (error, answer) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created SDPAnswer for SipEndpoint for room: ${this._roomId}`);

				return resolve(answer);
			});
		});
	}

	async _createRtpEndpoint()
	{
		logger.debug('_createRtpEndpoint()');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			pipeline.create('RtpEndpoint', (error, rtpEndpoint) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created RtpEndpoint for room: ${this._roomId}`);

				return resolve(rtpEndpoint);
			});
		});
	}

	async _createHubPort()
	{
		logger.debug('_createHubPort()');

		const composite = await this._getComposite();

		return new Promise((resolve, reject) =>
		{
			composite.createHubPort((error, hubPort) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created HubPort for room: ${this._roomId}`);

				return resolve(hubPort);
			});
		});
	}
}

module.exports = Room;

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
	constructor(roomId, srf, kurentoClient, displayName)
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

		// Manager of spotlight
		this._spotlights = new Spotlights();

		// Current consumer in spotlight
		this._currentConsumerSpotlight = null;

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
		this._displayName = displayName;

		// This device
		this._device = {
			flag    : 'sipendpoint',
			name    : 'SIP Endpoint',
			version : undefined
		};

		// Kurento client instance
		this._kurentoClient = kurentoClient;

		// Kurento Mediapipeline
		this._pipeline = null;

		// Kurento Composite node
		this._composite = null;

		// Kurento GStreamFilter particpant number
		this._participantsFilter = null;

		// Kurento GStreamFilter participant display name
		this._participantFilter = null;

		// Kurento waiting video PlayerEndpoint
		this._playerEndpoint = null;

		// Kurento notification audio PlayerEndpoint
		this._notificationEndpoint = null;

		// Kurento notification HubPort
		this._notificationHubPort = null;

		// Connection timeout
		this._connectionTimeout = null;

		// Kurento internal SIP RtpEndpoint
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

		if (this._audioProducerEndpoint)
			this._audioProducerEndpoint.release();

		if (this._videoProducerEndpoint)
			this._videoProducerEndpoint.release();

		if (this._sipHubPort)
			this._sipHubPort.release();

		if (this._sipEndpoint)
			this._sipEndpoint.release();

		if (this._participantFilter)
			this._participantFilter.release();

		if (this._participantsFilter)
			this._participantsFilter.release();

		if (this._playerEndpoint)
			this._playerEndpoint.release();

		if (this._notificationEndpoint)
			this._notificationEndpoint.release();

		if (this._notificationHubPort)
			this._notificationHubPort.release();

		if (this.composite)
			this._composite.release();

		if (this._pipeline)
			this._pipeline.release();

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
			// This is the SDP from Kurento
			const localSdp = await this._processSipSdp(req.body, 'RtpEndpoint');

			this._dialog = await this._srf.createUAS(req, res, {
				localSdp : localSdp,
				headers  : {
					'User-Agent' : 'multiparty-meeting-sipgw'
				}
			});

			this._dialog.on('destroy', () =>
			{
				logger.debug('handleCall() | caller hung up');

				this.close();
			});

			// eslint-disable-next-line space-before-function-paren
			this._dialog.on('modify', (modifyreq, modifyres) =>
			{
				logger.debug('handleCall() | caller sent reInvite');

				// This is the SDP from Kurento
				this._processSipSdp(modifyreq.body, 'RtpEndpoint')
					.then((newLocalSdp) =>
					{
						modifyres.send(200, {
							localSdp : newLocalSdp,
							headers  : {
								'User-Agent' : 'multiparty-meeting-sipgw'
							}
						});
					});
			});

			logger.info('handleCall() | dialog created');

			this._join({
				displayName : this._displayName,
				device      : this._device
			});
		}
		catch (error)
		{
			if (error instanceof Srf.SipError && error.status === 487)
			{
				logger.debug('handleCall() | call canceled by caller');
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
				forceNew           : true,
				transports         : [ 'websocket' ]
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

			this._handlePeer(peer)
				.then(() =>
				{
					return this._getNotificationEndpoint();
				})
				.then((player) =>
				{
					player.play();
					// this._updateSpotlight(this._spotlights.currentSpotlight());
				})
				.catch((error) =>
				{
					logger.error('newpeer failed:%o', error);
				});
		});

		try
		{
			await this._room.join(this._peerName, { displayName, device });

			await this._createNotificationPlayer();

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

			this._spotlights.on('spotlights-updated', (peerName) =>
			{
				this._updateSpotlight(peerName);
			});

			const peers = this._room.peers;

			for (const peer of peers)
			{
				await this._handlePeer(peer);
			}

			this._spotlights.start();
		}
		catch (error)
		{
			logger.error('_joinRoom() failed:%o', error);

			this.close();
		}
	}

	// Updated consumers based on spotlights
	async _updateSpotlight(peerName)
	{
		logger.debug('_updateSpotlight() [peerName:%s]', peerName);

		if (this._closed)
		{
			logger.debug('_updateSpotlight() | room closed');

			return;
		}

		try
		{
			const sipEndpoint = await this._getSipEndpoint();

			// Check for screen sharing first, and show that
			for (const peer of this._room.peers)
			{
				for (const peerconsumer of peer.consumers)
				{
					if (peerconsumer.appData.source !== 'screen' || !peerconsumer.supported)
						continue;

					// This consumer is already in spotlight
					if (this._currentConsumerSpotlight === peerconsumer.id)
						return;

					this._currentConsumerSpotlight = peerconsumer.id;

					const { rtpEndpoint } = this._consumerEndpoints[peerconsumer.id];

					// const numberFilter = await this._getParticipantsFilter(this._room.peers.length);

					// Media flow: rtpEndpoint -------> numberFilter
					// await this._connectMediaElements(
					//	rtpEndpoint, numberFilter, 'VIDEO'
					// );

					// Media flow: numberFilter -------> sipEndpoint
					// await this._connectMediaElements(
					//	numberFilter, sipEndpoint, 'VIDEO'
					// );

					// Media flow: rtpEndpoint -------> numberFilter
					await this._connectMediaElements(
						rtpEndpoint, sipEndpoint, 'VIDEO'
					);

					await this._sendRequest('request-consumer-keyframe', { consumerId: peerconsumer.id });

					return;
				}
			}

			// NOTE: Hack, we shouldn't do this, but this is just a demo.
			const speaker = this._room.getPeerByName(peerName);

			if (!speaker)
			{
				logger.error('_updateSpotlight() | speaker not found');

				// This consumer is already in spotlight
				if (this._currentConsumerSpotlight === 'PLAYER')
					return;

				const playerEndpoint = await this._getPlayerEndpoint();
				// const numberFilter = await this._getParticipantsFilter(this._room.peers.length);

				this._currentConsumerSpotlight = 'PLAYER';

				// Media flow: playerEndpoint -------> numberFilter
				// await this._connectMediaElements(
				//	playerEndpoint, numberFilter, 'VIDEO'
				// );

				// Media flow: numberFilter -------> sipEndpoint
				// await this._connectMediaElements(
				//	numberFilter, sipEndpoint, 'VIDEO'
				// );

				// Media flow: numberFilter -------> sipEndpoint
				await this._connectMediaElements(
					playerEndpoint, sipEndpoint, 'VIDEO'
				);

				return;
			}

			for (const consumer of speaker.consumers)
			{
				if (consumer.kind !== 'video' || !consumer.supported)
					continue;

				if (!this._consumerEndpoints[consumer.id])
				{
					logger.debug('_updateSpotlight() | missing Consumer endpoint');
					continue;
				}

				// This consumer is already in spotlight
				if (this._currentConsumerSpotlight === consumer.id)
					return;

				this._currentConsumerSpotlight = consumer.id;

				const { rtpEndpoint } = this._consumerEndpoints[consumer.id];

				// const nameFilter = await this._getParticipantFilter(speaker.appData.displayName);
				// const numberFilter = await this._getParticipantsFilter(this._room.peers.length);

				// Media flow: rtpEndpoint -------> numberFilter
				// await this._connectMediaElements(
				//	rtpEndpoint, numberFilter, 'VIDEO'
				// );

				// Media flow: numberFilter -------> nameFilter
				// await this._connectMediaElements(
				//	numberFilter, nameFilter, 'VIDEO'
				// );

				// Media flow: nameFilter -------> sipEndpoint
				// await this._connectMediaElements(
				//	nameFilter, sipEndpoint, 'VIDEO'
				// );

				// Media flow: rtpEndpoint -------> sipEndpoint
				await this._connectMediaElements(
					rtpEndpoint, sipEndpoint, 'VIDEO'
				);

				await this._sendRequest('request-consumer-keyframe', { consumerId: consumer.id });

				logger.debug('_updateSpotlight() | done');

				return;
			}

			// If we come here, we have a speaker, but speaker has no video
			logger.error('_updateSpotlight() | speaker has no video');

			// This consumer is already in spotlight
			if (this._currentConsumerSpotlight === 'PLAYER')
				return;

			const playerEndpoint = await this._getPlayerEndpoint();
			// const numberFilter = await this._getParticipantsFilter(this._room.peers.length);

			this._currentConsumerSpotlight = 'PLAYER';

			// Media flow: playerEndpoint -------> numberFilter
			// await this._connectMediaElements(
			//	playerEndpoint, numberFilter, 'VIDEO'
			// );

			// Media flow: numberFilter -------> sipEndpoint
			// await this._connectMediaElements(
			//	numberFilter, sipEndpoint, 'VIDEO'
			// );

			// Media flow: numberFilter -------> sipEndpoint
			await this._connectMediaElements(
				playerEndpoint, sipEndpoint, 'VIDEO'
			);

			return;
		}
		catch (error)
		{
			logger.error('_updateSpotlight() failed: %o', error);
		}
	}

	_timeoutCallback(callback)
	{
		logger.debug('_timeoutCallback()');

		let called = false;

		const interval = setTimeout(
			() =>
			{
				if (called)
					return;

				called = true;

				callback(new Error('Request timeout'));
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
		logger.debug('_sendRequest()');

		return new Promise((resolve, reject) =>
		{
			if (!this._signalingSocket)
			{
				reject('No socket connection');
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

			const endpoint = await this._getAudioProducerEndpoint();

			this._audioProducer.endpoint = endpoint;

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

			const endpoint = await this._getVideoProducerEndpoint();

			this._videoProducer.endpoint = endpoint;

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

	async _handlePeer(peer)
	{
		logger.debug('_handlePeer()');

		for (const consumer of peer.consumers)
		{
			await this._handleConsumer(consumer);
		}

		this._spotlights.newPeer(peer);

		peer.on('close', (originator) =>
		{
			logger.debug(
				'peer "close" event [name:"%s", originator:%s]',
				peer.name, originator);

			// this._updateSpotlight(this._spotlights.currentSpotlight());

			this._spotlights.peerClose(peer);
		});

		peer.on('newconsumer', (consumer) =>
		{
			logger.debug(
				'peer "newconsumer" event [name:"%s", id:%s, consumer:%o]',
				peer.name, consumer.id, consumer);

			this._handleConsumer(consumer)
				.then(() =>
				{
					if (
						this._spotlights.currentSpotlight() === peer.name ||
						consumer.appData.source === 'screen'
					)
						this._updateSpotlight(this._spotlights.currentSpotlight());
				});
		});
	}

	async _handleConsumer(consumer)
	{
		logger.debug('_handleConsumer()');

		consumer.on('close', (originator) =>
		{
			logger.debug(
				'consumer "close" event [id:%s, originator:%s, consumer:%o]',
				consumer.id, originator, consumer);

			if (this._currentConsumerSpotlight === consumer.id)
				this._updateSpotlight(this._spotlights.currentSpotlight());

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

			if (consumer.kind === 'audio')
			{
				return Promise.resolve()
					.then(() =>
					{
						return this._createRtpEndpoint();
					})
					.then((rtpEndpoint) =>
					{
						this._consumerEndpoints[consumer.id] = { rtpEndpoint };
						consumer.endpoint = rtpEndpoint;

						return this._createHubPort();
					})
					.then((hubPort) =>
					{
						this._consumerEndpoints[consumer.id].hubPort = hubPort;

						// Media flow: rtpEndpoint -------> hubPort
						return this._connectMediaElements(
							consumer.endpoint,
							hubPort,
							'AUDIO'
						);
					})
					.then(() =>
					{
						consumer.receive(transport);
					})
					.catch((error) =>
					{
						logger.error(
							'unexpected error while receiving a new Consumer:%o', error);
					});
			}
			else
			{
				return Promise.resolve()
					.then(() =>
					{
						return this._createRtpEndpoint();
					})
					.then((rtpEndpoint) =>
					{
						this._consumerEndpoints[consumer.id] = { rtpEndpoint, hubPort: null };
						consumer.endpoint = rtpEndpoint;
					})
					.then(() =>
					{
						consumer.receive(transport);
					})
					.catch((error) =>
					{
						logger.error(
							'unexpected error while receiving a new Consumer:%o', error);
					});
			}
		}
	}

	async _getKurentoClient()
	{
		logger.debug('_getKurentoClient()');

		return new Promise((resolve, reject) =>
		{
			if (this._kurentoClient !== null)
			{
				logger.info('_getKurentoClient | KurentoClient already created');

				return resolve(this._kurentoClient);
			}

			kurento(kurentoConfig.uri, (error, kurentoClient) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`_getKurentoClient | created KurentoClient, connected to: ${kurentoConfig.uri}`);

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
				logger.info('_getPipeline | Pipeline already created');

				return resolve(this._pipeline);
			}

			kurentoClient.create('MediaPipeline', (error, pipeline) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('_getPipeline | created MediaPipeline');

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
				logger.info('_getComposite | Composite already created');

				return resolve(this._composite);
			}

			pipeline.create('Composite', (error, composite) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('_getComposite | created Composite');

				this._composite = composite;

				return resolve(this._composite);
			});
		});
	}

	async _getParticipantsFilter(number)
	{
		logger.debug('_getParticipantsFilter');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			pipeline.create('GStreamerFilter', {
				command : `textoverlay font-desc="Sans 16" text="${number}" valignment=top halignment=right shaded-background=true`
			}, (error, filter) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				this._participantsFilter = filter;

				return resolve(filter);
			});
		});
	}

	async _getParticipantFilter(text)
	{
		logger.debug('_getParticipantFilter');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			pipeline.create('GStreamerFilter', {
				command : `textoverlay font-desc="Sans 16" text="${text}" valignment=bottom halignment=right shaded-background=true`
			}, (error, filter) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				this._participantFilter = filter;

				return resolve(filter);
			});
		});
	}

	async _createNotificationPlayer()
	{
		logger.debug('_createNotificationPlayer');

		try
		{
			const notificationPlayer = await this._getNotificationEndpoint();
			const notificationHubPort = await this._createHubPort();

			await this._connectMediaElements(notificationPlayer, notificationHubPort, 'AUDIO');
		}
		catch (error)
		{
			logger.error(error);
		}
	}

	async _getNotificationEndpoint()
	{
		logger.debug('_getNotificationEndpoint');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			if (this._notificationEndpoint !== null)
			{
				logger.info('_getNotificationEndpoint | PlayerEndpoint already created');

				return resolve(this._notificationEndpoint);
			}

			pipeline.create('PlayerEndpoint', { uri: kurentoConfig.notificationUrl }, (error, player) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('_getNotificationEndpoint | created PlayerEndpoint');

				this._notificationEndpoint = player;

				return resolve(this._notificationEndpoint);
			});
		});
	}

	async _getPlayerEndpoint()
	{
		logger.debug('_getPlayerEndpoint()');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			if (this._playerEndpoint !== null)
			{
				logger.info('_getPlayerEndpoint | PlayerEndpoint already created');

				return resolve(this._playerEndpoint);
			}

			pipeline.create('PlayerEndpoint', { uri: kurentoConfig.waitingVideoUrl }, (error, player) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('_getPlayerEndpoint | created PlayerEndpoint');

				this._playerEndpoint = player;

				this._playerEndpoint.on('EndOfStream', () =>
				{
					logger.info('_getPlayerEndpoint | looping PlayerEndpoint');

					this._playerEndpoint.play();
				});

				this._playerEndpoint.play();

				return resolve(this._playerEndpoint);
			});
		});
	}

	async _createInternalConnections()
	{
		logger.debug('_createInternalConnections()');

		try
		{
			const hubPort = await this._getSipHubPort();
			const playerEndpoint = await this._getPlayerEndpoint();
			const audioEndpoint = await this._getAudioProducerEndpoint();
			const videoEndpoint = await this._getVideoProducerEndpoint();
			const sipEndpoint = await this._getSipEndpoint();

			// Media flow: hubPort -------> sipEndpoint
			await this._connectMediaElements(hubPort, sipEndpoint, 'AUDIO');

			// Media flow: playerEndpoint -------> sipEndpoint
			await this._connectMediaElements(playerEndpoint, sipEndpoint, 'VIDEO');

			// Media flow: sipEndpoint -------> audioEndpoint
			await this._connectMediaElements(sipEndpoint, audioEndpoint, 'AUDIO');

			// Media flow: sipEndpoint -------> videoEndpoint
			await this._connectMediaElements(sipEndpoint, videoEndpoint, 'VIDEO');
		}
		catch (error)
		{
			logger.error(error);
		}
	}

	async _getAudioProducerEndpoint()
	{
		logger.debug('_getAudioProducerEndpoint()');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			if (this._audioProducerEndpoint !== null)
			{
				logger.info('_getAudioProducerEndpoint | Endpoint already created');

				return resolve(this._audioProducerEndpoint);
			}

			pipeline.create('RtpEndpoint', (error, endpoint) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('_getAudioProducerEndpoint | created AudioProducerEndpoint');

				this._audioProducerEndpoint = endpoint;

				return resolve(this._audioProducerEndpoint);
			});
		});
	}

	async _getVideoProducerEndpoint()
	{
		logger.debug('_getVideoProducerEndpoint()');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			if (this._videoProducerEndpoint !== null)
			{
				logger.info('_getVideoProducerEndpoint | Endpoint already created');

				return resolve(this._videoProducerEndpoint);
			}

			pipeline.create('RtpEndpoint', (error, endpoint) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('_getVideoProducerEndpoint | created VideoProducerEndpoint');

				this._videoProducerEndpoint = endpoint;

				return resolve(this._videoProducerEndpoint);
			});
		});
	}

	async _getSipHubPort()
	{
		logger.debug('_getSipHubPort()');

		const composite = await this._getComposite();

		return new Promise((resolve, reject) =>
		{
			if (this._sipHubPort !== null)
			{
				logger.info('_getSipHubPort() | HubPort already created');

				return resolve(this._sipHubPort);
			}

			composite.createHubPort((error, hubPort) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('_getSipHubPort() | created HubPort');

				this._sipHubPort = hubPort;

				return resolve(this._sipHubPort);
			});
		});
	}

	async _getSipEndpoint({ recreate = false, type = 'RtpEndpoint' } = {})
	{
		logger.debug('_getSipEndpoint()');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			if (recreate &&
				this._sipEndpoint !== null)
			{
				this._sipEndpoint.release();
				this._sipEndpoint = null;
			}

			if (this._sipEndpoint !== null)
			{
				logger.info('_getSipEndpoint | sipEndpoint already created');

				return resolve(this._sipEndpoint);
			}

			if (this._connectionTimeout)
				clearTimeout(this._connectionTimeout);

			pipeline.create(type, (error, sipEndpoint) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				// If we don't get connected in 10 sec, we close
				this._connectionTimeout = setTimeout(() =>
				{
					logger.info('_getSipEndpoint | timed out, closing');

					this.close();
				}, 30000);

				sipEndpoint.on('MediaStateChanged', (event) =>
				{
					logger.info('_getSipEndpoint | MediaStateChanged [state:%s]', event.newState);

					// If we get the event, it is either connected or disconnected,
					// either way, clear timeout
					if (this._connectionTimeout)
						clearTimeout(this._connectionTimeout);

					if (event.newState === 'DISCONNECTED')
						this.close();
				});

				logger.info('_getSipEndpoint | created sipEndpoint');

				this._sipEndpoint = sipEndpoint;

				return resolve(this._sipEndpoint);
			});
		});
	}

	async _connectMediaElements(fromElement, toElement, options)
	{
		logger.debug('_connectMediaElements()');

		return new Promise((resolve, reject) =>
		{
			fromElement.connect(toElement, options, (error) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('_connectMediaElements | successfully connected endpoints');

				return resolve();
			});
		});
	}

	async _processSipSdp(offer, type) // type = RtpEndpoint/WebRtcEndpoint
	{
		logger.debug('_processSipSdp()');

		const sipEndpoint = await this._getSipEndpoint({ recreate: true, type: type });

		await this._createInternalConnections();

		return new Promise((resolve, reject) =>
		{
			if (type === 'WebRtcEndpoint')
			{
				sipEndpoint.on('IceCandidateFound', (event) =>
				{
					logger.info('_processSipSdp | candidate found [candidate:%o]', event.candidate);
				});

				sipEndpoint.on('IceGatheringDone', () =>
				{
					logger.info('_processSipSdp | ICE gathering done');

					sipEndpoint.getLocalSessionDescriptor((error, sdp) =>
					{
						if (error)
						{
							return reject(error);
						}

						return resolve(sdp);
					});
				});
			}

			sipEndpoint.processOffer(offer, (error, answer) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info('_processSipSdp | created SDP answer');

				if (type === 'WebRtcEndpoint')
				{
					sipEndpoint.gatherCandidates((gathererror) =>
					{
						if (gathererror)
						{
							return reject(gathererror);
						}

						logger.info('_processSipSdp | gathering candidates');
					});
				}
				else
				{
					return resolve(answer);
				}
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

				logger.info('_createRtpEndpoint | created RtpEndpoint');

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

				logger.info('_createHubPort | created HubPort');

				return resolve(hubPort);
			});
		});
	}
}

module.exports = Room;

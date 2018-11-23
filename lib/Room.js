const config = require('config');
const EventEmitter = require('events').EventEmitter;
const Srf = require('drachtio-srf');
const sdpTransform = require('sdp-transform');
const mediasoupClient = require('mediasoup-client');
const io = require('socket.io-client');
const MediaStreamTrack = require('node-mediastreamtrack');
const kurento = require('kurento-client');
const randomString = require('random-string');
const KurentoHandler = require('./KurentoHandler');
const Logger = require('./Logger');
const kurentoConfig = config.get('Kurento');
const mediasoupConfig = config.get('Mediasoup');
const roomConfig = config.get('Room');
const rtpEngineConfig = config.get('rtpengine');

const logger = new Logger('Room');

// const kurentoCharacteristics =
// {
//	'transport protocol' : 'RTP/AVP',
//	'ICE'                : 'remove',
//	'rtcp-mux'           : [ 'demux' ],
//	'replace'            : [ 'origin', 'session-connection' ]
// };

mediasoupClient.setDeviceHandler(KurentoHandler, {
	flag : 'kurento',
	name : 'Kurento'
});

class Room extends EventEmitter
{
	constructor(roomId, srf, rtpEngine)
	{
		logger.info('constructor() [roomId:"%s"]', roomId);

		super();
		this.setMaxListeners(Infinity);

		// Room ID
		this._roomId = roomId;

		// Peername in room
		this._peerName = randomString({ length: 8 }).toLowerCase();

		// Current active speaker
		this._activeSpeaker = null;

		// Multiparty-meeting room
		this._room = new mediasoupClient.Room(mediasoupConfig);
		this._room.roomId = roomId;

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

		// Kurento waiting video PlayerEndpoint
		this._playerEndpoint = null;

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

		// RtpEngine instance
		this._rtpEngine = rtpEngine;

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
			/* 
			const callid = req.get('Call-Id');
			const from = req.getParsedHeader('From');
			const totag = 'faf32f2';

			// Find the rtpengine mapping options corresponding,
			// but reverse to kurentoCharacteristics
			let incomingCharacteristics = this._getSdpCharacteristics(req.body);

			// Start creating incoming rtpengine endpoint here
			const incomingRtpEngineDetails = {
				'call-id'  : callid,
				'from-tag' : from.params.tag,
			};

			let incomingRtpEngineOptions = Object.assign(
				{ 'sdp': req.body },
				kurentoCharacteristics,
				incomingRtpEngineDetails
			);

			let incomingSdp = await this._rtpEngineOffer(incomingRtpEngineOptions);
			// Done creating incoming endpoint in rtpengine
			*/

			// This is the SDP from Kurento
			let localSdp = await this._processSipSdp(req.body);

			/*
			// Start creating outgoing rtpengine endpoint here
			const outgoingRtpEngineDetails = {
				'call-id'  : callid,
				'from-tag' : from.params.tag,
				'to-tag'   : totag
			};

			let outgoingRtpEngineOptions = Object.assign(
				{ 'sdp': localSdp },
				incomingCharacteristics,
				outgoingRtpEngineDetails
			);

			let outgoingSdp = await this._rtpEngineAnswer(outgoingRtpEngineOptions);
			// Done creating outgoing endpoint in rtpengine
			*/

			this._dialog = await this._srf.createUAS(req, res, {
				localSdp : localSdp,
				headers  : {
					'User-Agent' : 'multiparty-meeting-sipgw'
				}
			});

			this._dialog.on('destroy', () =>
			{
				logger.debug('Caller hung up');

				this.close();
			});

			// eslint-disable-next-line space-before-function-paren
			this._dialog.on('modify', async (modifyreq, modifyres) =>
			{
				logger.debug('Caller sent reInvite');

				/*
				// We need to delete rtpengine endpoints
				await this._rtpEngineDelete(incomingRtpEngineDetails);

				// Find the rtpengine mapping options corresponding,
				// but reverse to kurentoCharacteristics
				incomingCharacteristics = this._getSdpCharacteristics(modifyreq.body);

				// Start creating incoming rtpengine endpoint here
				incomingRtpEngineOptions = Object.assign(
					{ 'sdp': modifyreq.body },
					kurentoCharacteristics,
					incomingRtpEngineDetails
				);

				incomingSdp = await this._rtpEngineOffer(incomingRtpEngineOptions);
				// Done creating incoming endpoint in rtpengine
				*/

				// This is the SDP from Kurento
				localSdp = await this._processSipSdp(modifyreq.body);

				/*
				// Start creating outgoing rtpengine endpoint here
				outgoingRtpEngineOptions = Object.assign(
					{ 'sdp': localSdp },
					incomingCharacteristics,
					outgoingRtpEngineDetails
				);

				outgoingSdp = await this._rtpEngineAnswer(outgoingRtpEngineOptions);
				// Done creating outgoing endpoint in rtpengine
				*/

				modifyres.send(200, {
					localSdp : localSdp,
					headers  : {
						'User-Agent' : 'multiparty-meeting-sipgw'
					}
				});
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

	_rtpEngineOffer(options)
	{
		logger.debug('_rtpEngineOffer() [options:%o]', options);

		return Promise.resolve()
			.then(() =>
			{
				return this._rtpEngine.offer(rtpEngineConfig, options);
			})
			.then((response) =>
			{
				if (response.result !== 'ok')
					throw new Error('failed allocating offer endpoint from rtpengine');

				return response.sdp;
			});
	}

	_rtpEngineAnswer(options)
	{
		logger.debug('_rtpEngineAnswer() [options:%o]', options);

		return Promise.resolve()
			.then(() =>
			{
				return this._rtpEngine.answer(rtpEngineConfig, options);
			})
			.then((response) =>
			{
				if (response.result !== 'ok')
					throw new Error('failed allocating answer endpoint from rtpengine');

				return response.sdp;
			});
	}

	_rtpEngineDelete(options)
	{
		logger.debug('_rtpEngineDelete() [options:%o]', options);

		return Promise.resolve()
			.then(() =>
			{
				return this._rtpEngine.delete(rtpEngineConfig, options);
			})
			.then((response) =>
			{
				if (response.result !== 'ok')
					throw new Error('failed to delete endpoint from rtpengine');
			});
	}

	_getSdpCharacteristics(sdp)
	{
		logger.debug('_getSdpCharacteristics()');

		const sdpObj = sdpTransform.parse(sdp);

		const sdpCharacteristics = { 'replace': [ 'origin', 'session-connection' ] };

		if (sdpObj.media[0])
		{
			sdpCharacteristics['transport protocol'] = sdpObj.media[0].protocol;

			if (sdpObj.icePwd || sdpObj.media[0].icePwd)
				sdpCharacteristics['ICE'] = 'force';
			else
				sdpCharacteristics['ICE'] = 'remove';

			if (sdpObj.media[0].rtcpMux)
				sdpCharacteristics['rtcp-mux'] = [ 'require' ];
			else
				sdpCharacteristics['rtcp-mux'] = [ 'demux' ];
		}

		return sdpCharacteristics;
	}

	_filterBody(body)
	{
		logger.debug('_filterBody() [body:%s]', body);

		const remoteSdpObj = sdpTransform.parse(body);

		logger.debug('_filterBody() [sdpObj:%o]', remoteSdpObj);

		let mLength = remoteSdpObj.media.length;

		while (mLength--)
		{
			logger.debug(
				'_filterBody() [invalid:%o]',
				remoteSdpObj.media[mLength].invalid
			);

			for (const aLine of remoteSdpObj.media[mLength].invalid)
			{
				if (aLine.value === 'content:main')
				{
					break;
				}
				else if (aLine.value.includes('content'))
				{
					remoteSdpObj.media.splice(mLength, 1);
					break;
				}
			}
		}

		const filteredSdp = sdpTransform.write(remoteSdpObj);

		logger.debug('_filterBody() [filteredSdp:%s]', filteredSdp);

		return filteredSdp;
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
			{
				this._activeSpeaker = peerName;
				this._updateSpeaker();
			}
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

			const peers = this._room.peers;

			for (const peer of peers)
			{
				this._handlePeer(peer);

				this._activeSpeaker = peer.name;
			}

			this._updateSpeaker();
		}
		catch (error)
		{
			logger.error('_joinRoom() failed:%o', error);

			this.close();
		}
	}

	async _updateSpeaker()
	{
		logger.debug('_updateSpeaker');

		const sipEndpoint = await this._getSipEndpoint();

		// Check for screen sharing first, and show that
		for (const peer of this._room.peers)
		{
			for (const peerconsumer of peer.consumers)
			{
				if (peerconsumer.appData.source !== 'screen' || !peerconsumer.supported)
					continue;

				const { rtpEndpoint } = this._consumerEndpoints[peerconsumer.id];

				// Media flow: rtpEndpoint -------> sipEndpoint
				await this._connectMediaElements(
					rtpEndpoint, sipEndpoint, peerconsumer.kind.toUpperCase()
				);

				await this._sendRequest('request-consumer-keyframe', { consumerId: peerconsumer.id });

				return;
			}
		}

		const speaker = this._room.getPeerByName(this._activeSpeaker);

		if (!speaker)
		{
			logger.error('_updateSpeaker | speaker not found');

			const playerEndpoint = await this._getPlayerEndpoint();

			// Media flow: playerEndpoint -------> sipEndpoint
			await this._connectMediaElements(
				playerEndpoint, sipEndpoint, 'VIDEO'
			);

			return;
		}

		for (const consumer of speaker.consumers)
		{
			if (consumer.kind !== 'video' || !consumer.supported)
				continue;

			const { rtpEndpoint } = this._consumerEndpoints[consumer.id];

			// Media flow: rtpEndpoint -------> sipEndpoint
			await this._connectMediaElements(
				rtpEndpoint, sipEndpoint, consumer.kind.toUpperCase()
			);

			await this._sendRequest('request-consumer-keyframe', { consumerId: consumer.id });

			return;
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

			if (peer.name === this._activeSpeaker)
			{
				this._activeSpeaker = null;
				this._updateSpeaker();
			}
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

			if (consumer.peer.name === this._activeSpeaker &&
				consumer.appData.source === 'screen')
			{
				this._updateSpeaker();
			}

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

			if (consumer.kind === 'audio')
			{
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
			else
			{
				Promise.resolve()
					.then(() =>
					{
						return this._createRtpEndpoint();
					})
					.then((endpoint) =>
					{
						rtpEndpoint = endpoint;

						this._consumerEndpoints[consumer.id] = {
							rtpEndpoint
						};

						consumer.endpoint = rtpEndpoint;
					})
					.then(() =>
					{
						return consumer.receive(this._recvTransports[consumer.id]);
					})
					.then(() =>
					{
						if (consumer.appData.source === 'screen')
							this._updateSpeaker();
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

	async _getPlayerEndpoint()
	{
		logger.debug('_getAudioProducerEndpoint()');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			if (this._playerEndpoint !== null)
			{
				logger.info('PlayerEndpoint already created');

				return resolve(this._playerEndpoint);
			}

			pipeline.create('PlayerEndpoint', { uri: kurentoConfig.waitingVideoUrl }, (error, player) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created PlayerEndpoint for room: ${this._roomId}`);

				this._playerEndpoint = player;

				this._playerEndpoint.on('EndOfStream', () =>
				{
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

	async _getAudioProducerEndpoint()
	{
		logger.debug('_getAudioProducerEndpoint()');

		const pipeline = await this._getPipeline();

		return new Promise((resolve, reject) =>
		{
			if (this._audioProducerEndpoint !== null)
			{
				logger.info('AudioProducer Endpoint already created');

				return resolve(this._audioProducerEndpoint);
			}

			pipeline.create('RtpEndpoint', (error, endpoint) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created AudioProducer for room: ${this._roomId}`);

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
				logger.info('VideoProducer Endpoint already created');

				return resolve(this._videoProducerEndpoint);
			}

			pipeline.create('RtpEndpoint', (error, endpoint) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created VideoProducer for room: ${this._roomId}`);

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
				logger.info('Sip HubPort already created');

				return resolve(this._sipHubPort);
			}

			composite.createHubPort((error, hubPort) =>
			{
				if (error)
				{
					logger.error(error);

					return reject(error);
				}

				logger.info(`Created HubPort for room: ${this._roomId}`);

				this._sipHubPort = hubPort;

				return resolve(this._sipHubPort);
			});
		});
	}

	async _getSipEndpoint({ recreate = false } = {})
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

	async _processSipSdp(offer)
	{
		logger.debug('_processSipSdp() [offer:"%s"]', offer);

		const sipEndpoint = await this._getSipEndpoint({ recreate: true });

		await this._createInternalConnections();

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

const net = require('net');
const sdpTransform = require('sdp-transform');
const Logger = require('./Logger');
const {
	EnhancedEventEmitter,
	utils,
	ortc,
	sdpCommonUtils,
	sdpPlainRtpUtils,
	RemotePlainRtpSdp
} = require('mediasoup-client').internals;

const logger = new Logger('KurentoHandler');

const KurentoSdp = 'v=0\r\no=- 3751708968 3751708968 IN IP4 0.0.0.0\r\ns=Kurento Media Server\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\nm=audio 6914 RTP/AVPF 96 0 97\r\na=setup:actpass\r\na=extmap:3 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\na=rtpmap:96 opus/48000/2\r\na=rtpmap:97 AMR/8000\r\na=sendrecv\r\na=mid:audio0\r\na=ssrc:408388632 cname:user2393147957@host-b742b122\r\nm=video 60938 RTP/AVPF 102 103\r\na=setup:actpass\r\na=extmap:3 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time\r\na=fmtp:103 profile-level-id=42e01f;level-asymmetry-allowed=1;packetization-mode=1\r\na=rtpmap:102 VP8/90000\r\na=rtpmap:103 H264/90000\r\na=sendrecv\r\na=mid:video0\r\na=rtcp-fb:102 nack\r\na=rtcp-fb:102 nack pli\r\na=rtcp-fb:102 goog-remb\r\na=rtcp-fb:102 ccm fir\r\na=rtcp-fb:103 nack\r\na=rtcp-fb:103 nack pli\r\na=rtcp-fb:103 ccm fir\r\na=ssrc:3726442969 cname:user2393147957@host-b742b122\r\n';

// This handler can only have 1 consumer/producer
//
// The consumer/producer needs to have { endpoint }
// included from Application at higher level
class Handler extends EnhancedEventEmitter
{
	constructor(direction, rtpParametersByKind)
	{
		super(logger);

		// Generic sending RTP parameters for audio and video.
		// @type {Object}
		this._rtpParametersByKind = rtpParametersByKind;

		// Remote SDP handler.
		// @type {RemoteUnifiedPlanSdp}
		this._remoteSdp = new RemotePlainRtpSdp(direction, rtpParametersByKind);

		// The SDP from the producer/consumer endpoint
		// @type {String}
		this._localSdp = null;

		// consumer/producer kind: audio/video
		// @type {String}
		this._kind = null;
	}

	close()
	{
		logger.debug('close()');
	}

	remoteClosed()
	{
		logger.debug('remoteClosed()');

		this._transportReady = false;

		if (this._transportUpdated)
			this._transportUpdated = false;
	}
}

class SendHandler extends Handler
{
	constructor(rtpParametersByKind, settings)
	{
		super('send', rtpParametersByKind, settings);

		// Got transport local and remote parameters.
		// @type {Boolean}
		this._transportReady = false;

		this._hasProducer = false;
	}

	async addProducer(producer)
	{
		if (this._hasProducer)
			return Promise.reject(new Error('This handler can only have one producer'));

		const { endpoint } = producer;

		logger.debug(
			'addProducer() [id:%s, kind:%s]',
			producer.id, producer.kind);

		if (!endpoint)
			return Promise.reject(new Error('Producer has no endpoint'));

		this._kind = producer.kind;

		try
		{
			this._localSdp = await endpoint.generateOffer();

			logger.debug('addProducer() [offer:%o]', this._localSdp);

			if (!this._transportReady)
				await this._setupTransport();

			const localSdpObj = sdpTransform.parse(this._localSdp);
			const remoteSdp = this._remoteSdp.createAnswerSdp(localSdpObj);
			const answer = { type: 'answer', sdp: remoteSdp };

			logger.debug('addProducer() [answer:%o]', answer);

			// Do Kurento magic here
			await endpoint.processAnswer(answer.sdp);

			this._hasProducer = true;

			const rtpParameters = utils.clone(this._rtpParametersByKind[producer.kind]);

			// Fill the RTP parameters for this track.
			sdpPlainRtpUtils.fillRtpParametersForKind(
				rtpParameters, localSdpObj, producer.kind);

			return rtpParameters;
		}
		catch (error)
		{
			throw error;
		}
	}

	async removeProducer(producer)
	{
		const { endpoint } = producer;

		logger.debug(
			'removeProducer() [id:%s, kind:%s]',
			producer.id, producer.kind);

		if (!endpoint)
			return Promise.reject(new Error('Producer has no endpoint'));

		// This handler can only have 1 consumer/producer, nothing to do
		endpoint.release();
	}

	async _setupTransport()
	{
		logger.debug('_setupTransport()');

		try
		{
			// Get our local DTLS parameters.
			const transportLocalParameters = {};
			const sdp = this._localSdp;
			const sdpObj = sdpTransform.parse(sdp);
			const localPlainRtpParameters = sdpPlainRtpUtils
				.extractPlainRtpParametersByKind(sdpObj, this._kind);

			transportLocalParameters.plainRtpParameters = localPlainRtpParameters;

			// Provide the remote SDP handler with transport local parameters.
			this._remoteSdp.setTransportLocalParameters(transportLocalParameters);

			// We need transport remote parameters.
			const transportRemoteParameters = await this.safeEmitAsPromise(
				'@needcreatetransport', transportLocalParameters);

			const { plainRtpParameters } = transportRemoteParameters;

			const version = net.isIP(plainRtpParameters.ip);

			if (!version)
				throw new Error('Invalid IP address in plainRtpParameters');

			plainRtpParameters.version = version;

			// Provide the remote SDP handler with transport remote parameters.
			this._remoteSdp.setTransportRemoteParameters(transportRemoteParameters);

			this._transportReady = true;
		}
		catch (error)
		{
			throw error;
		}
	}
}

class RecvHandler extends Handler
{
	constructor(rtpParametersByKind, settings)
	{
		super('recv', rtpParametersByKind, settings);

		// Got transport remote parameters.
		// @type {Boolean}
		this._transportCreated = false;

		// Got transport local parameters.
		// @type {Boolean}
		this._transportUpdated = false;

		this._hasConsumer = false;

		// Consumer information
		// - mid {String}
		// - kind {String}
		// - closed {Boolean}
		// - trackId {String}
		// - ssrc {Number}
		// - rtxSsrc {Number}
		// - cname {String}
		// @type {Object}
		this._consumerInfo = null;
	}

	async addConsumer(consumer)
	{
		logger.debug(
			'addConsumer() [id:%s, kind:%s]', consumer.id, consumer.kind);

		if (this._hasConsumer)
			return Promise.reject(new Error('This handler can only have one consumer'));

		const { endpoint } = consumer;

		if (!endpoint)
			return Promise.reject(new Error('Consumer has no endpoint'));

		const encoding = consumer.rtpParameters.encodings[0];
		const cname = consumer.rtpParameters.rtcp.cname;

		this._consumerInfo =
		{
			kind     : consumer.kind,
			streamId : `recv-stream-${consumer.id}`,
			trackId  : `consumer-${consumer.kind}-${consumer.id}`,
			ssrc     : encoding.ssrc,
			cname    : cname
		};

		if (encoding.rtx && encoding.rtx.ssrc)
			this._consumerInfo.rtxSsrc = encoding.rtx.ssrc;

		this._kind = consumer.kind;

		try
		{
			if (!this._transportCreated)
				await this._setupTransport();

			const remoteSdp = 
				this._remoteSdp.createOfferSdp([ this._consumerInfo ]);
			const offer = { type: 'offer', sdp: remoteSdp };

			logger.debug(
				'addConsumer() [offer:%o]',
				offer);

			// Do Kurento magic here
			this._localSdp = await endpoint.processOffer(offer.sdp);

			logger.debug(
				'addConsumer() [answer:%o]',
				this._localSdp);

			if (!this._transportUpdated)
				await this._updateTransport();

			this._hasConsumer = true;
		}
		catch (error)
		{
			throw error;
		}
	}

	async removeConsumer(consumer)
	{
		logger.debug(
			'removeConsumer() [id:%s, kind:%s]', consumer.id, consumer.kind);

		if (!this._consumerInfo)
			return Promise.reject(new Error('No such consumer present'));

		const { endpoint } = consumer;

		if (!endpoint)
			return Promise.reject(new Error('Consumer has no endpoint'));

		// This handler can only have 1 consumer/producer, nothing to do
		endpoint.release();
	}

	async _setupTransport()
	{
		logger.debug('_setupTransport()');

		try
		{
			const transportLocalParameters = {
				plainRtpParameters : {}
			};

			// We need transport remote parameters.
			const transportRemoteParameters = await this.safeEmitAsPromise(
				'@needcreatetransport', transportLocalParameters
			);

			const { plainRtpParameters } = transportRemoteParameters;

			const version = net.isIP(plainRtpParameters.ip);

			if (!version)
				throw new Error('Invalid IP address in plainRtpParameters');

			plainRtpParameters.version = version;

			// Provide the remote SDP handler with transport remote parameters.
			this._remoteSdp.setTransportRemoteParameters(transportRemoteParameters);

			this._transportCreated = true;
		}
		catch (error)
		{
			throw error;
		}
	}

	_updateTransport()
	{
		logger.debug('_updateTransport()');

		// Get our local DTLS parameters.
		// const transportLocalParameters = {};
		const sdp = this._localSdp;
		const sdpObj = sdpTransform.parse(sdp);
		const plainRtpParameters = sdpPlainRtpUtils
			.extractPlainRtpParametersByKind(sdpObj, this._kind);
		const transportLocalParameters = { plainRtpParameters };

		// We need to provide transport local parameters.
		this.safeEmit('@needupdatetransport', transportLocalParameters);

		this._transportUpdated = true;
	}
}

module.exports = class KurentoHandler
{
	static get tag()
	{
		return 'Kurento';
	}

	static getNativeRtpCapabilities()
	{
		logger.debug('getNativeRtpCapabilities()');

		return Promise.resolve()
			.then(() =>
			{
				const sdpObj = sdpTransform.parse(KurentoSdp);
				const nativeRtpCapabilities = sdpCommonUtils.extractRtpCapabilities(sdpObj);

				return nativeRtpCapabilities;
			});
	}

	constructor(direction, extendedRtpCapabilities, settings)
	{
		logger.debug(
			'constructor() [direction:%s, extendedRtpCapabilities:%o]',
			direction, extendedRtpCapabilities);

		let rtpParametersByKind;

		switch (direction)
		{
			case 'send':
			{
				rtpParametersByKind =
				{
					audio : ortc.getSendingRtpParameters('audio', extendedRtpCapabilities),
					video : ortc.getSendingRtpParameters('video', extendedRtpCapabilities)
				};

				return new SendHandler(rtpParametersByKind, settings);
			}
			case 'recv':
			{
				rtpParametersByKind =
				{
					audio : ortc.getReceivingFullRtpParameters('audio', extendedRtpCapabilities),
					video : ortc.getReceivingFullRtpParameters('video', extendedRtpCapabilities)
				};

				return new RecvHandler(rtpParametersByKind, settings);
			}
		}
	}
};

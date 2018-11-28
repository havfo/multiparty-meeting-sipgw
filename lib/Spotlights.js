const EventEmitter = require('events').EventEmitter;
const Logger = require('./Logger');

const logger = new Logger('Spotlight');

class Spotlights extends EventEmitter
{
	constructor()
	{
		super();

		this._peerList = [];
		this._currentSpotlight = null;
		this._started = false;
	}

	start()
	{
		logger.debug('start()');

		this._started = true;
		this._spotlightsUpdated();
	}

	newPeer(peer)
	{
		logger.debug('newPeer() [peerName:"%s"]', peer.name);

		if (!this._peerList.includes(peer.name)) // We don't have this peer in the list
		{
			logger.debug('newPeer() | adding peer [peerName:"%s"]', peer.name);

			this._peerList.push(peer.name);

			if (this._started)
				this._spotlightsUpdated();
		}
	}

	peerClose(peer)
	{
		logger.debug('peerClose() | peer "close" [peerName:"%s"]', peer.name);

		const index = this._peerList.indexOf(peer.name);

		if (index !== -1) // We have this peer in the list, remove
		{
			this._peerList.splice(index, 1);

			if (this._started)
				this._spotlightsUpdated();
		}
	}

	handleActiveSpeaker(peerName)
	{
		logger.debug('handleActiveSpeaker() [peerName:"%s"]', peerName);

		if (!this._started)
			logger.debug('handleActiveSpeaker() | not started yet');

		const index = this._peerList.indexOf(peerName);

		if (index > -1)
		{
			this._peerList.splice(index, 1);
			this._peerList = [ peerName ].concat(this._peerList);
			if (this._started)
				this._spotlightsUpdated();
		}
	}

	currentSpotlight()
	{
		logger.debug('currentSpotlight()');

		return this._currentSpotlight;
	}

	_spotlightsUpdated()
	{
		if (this._peerList[0] == this._currentSpotlight)
		{
			logger.debug('_spotlightsUpdated() | spotlights not updated');
		}
		else
		{
			logger.debug('_spotlightsUpdated() | spotlights updated [peerName:%s]', this._peerList[0]);
			
			this._currentSpotlight = this._peerList[0];
			this.emit('spotlights-updated', this._currentSpotlight);
		}
	}
}

module.exports = Spotlights;

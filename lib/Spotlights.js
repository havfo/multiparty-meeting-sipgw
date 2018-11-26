const EventEmitter = require('events').EventEmitter;
const Logger = require('./Logger');

const logger = new Logger('Spotlight');

class Spotlights extends EventEmitter
{
	constructor(room)
	{
		super();

		this._room = room;
		this._peerList = [];
		this._currentSpotlight = null;
		this._started = false;
	}

	start()
	{
		logger.debug('start()');

		this._handleRoom();

		this._started = true;
		this._spotlightsUpdated();
	}

	_handleRoom()
	{
		logger.debug('_handleRoom()');

		this._room.on('newpeer', (peer) =>
		{
			logger.debug(
				'room "newpeer" event [name:"%s", peer:%o]', peer.name, peer);

			// Give main room time to start peer
			setTimeout(() =>
			{
				this._handlePeer(peer);
			}, 500);
		});

		const peers = this._room.peers;
		
		for (const peer of peers)
		{
			this._handlePeer(peer);
		}
	}

	_handlePeer(peer)
	{
		logger.debug('_handlePeer() [peerName:"%s"]', peer.name);

		peer.on('close', () =>
		{
			logger.debug('_handlePeer() | peer "close" [peerName:"%s"]', peer.name);
			let index = this._peerList.indexOf(peer.name);
			
			if (index !== -1) // We have this peer in the list, remove
			{
				this._peerList.splice(index, 1);
			}

			this._spotlightsUpdated();
		});

		if (!this._peerList.includes(peer.name)) // We don't have this peer in the list
		{
			logger.debug('_handlePeer() | adding peer [peerName:"%s"]', peer.name);

			this._peerList.push(peer.name);

			this._spotlightsUpdated();
		}
	}

	handleActiveSpeaker(peerName)
	{
		logger.debug('handleActiveSpeaker() [peerName:"%s"]', peerName);

		if (!this._started)
		{
			logger.debug('handleActiveSpeaker() | not started yet');
			return;
		}

		const index = this._peerList.indexOf(peerName);

		if (index > -1)
		{
			this._peerList.splice(index, 1);
			this._peerList = [ peerName ].concat(this._peerList);
			this._spotlightsUpdated();
		}
	}

	_spotlightsUpdated()
	{
		if (this._peerList[0] === this._currentSpotlight)
		{
			logger.debug('_spotlightsUpdated() | spotlights not updated');
		}
		else
		{
			logger.debug('_spotlightsUpdated() | spotlights updated, emitting');
			
			this._currentSpotlight = this._peerList[0];
			this.emit('spotlights-updated', this._currentSpotlight);
		}
	}
}

module.exports = Spotlights;

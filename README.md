# multiparty-meeting-sipgw

A SIP gateway for [multiparty-meeting](https://github.com/havfo/multiparty-meeting)

Try it by calling: `roomname@letsmeet.no`

This will make you join the other participants at: `https://letsmeet.no/roomname`

## Architecture
![multiparty-meeting-sipgw architecture](https://raw.githubusercontent.com/havfo/multiparty-meeting-sipgw/master/doc/multiparty-meeting-sipgw.png "multiparty-meeting-sipgw architecture")

## Kurento pipeline

For every incoming call, a Kurento MediaPipeline is created. The pipeline can be seen below, with some parts removed (waiting screen PlayerEndpoint, notification sound PlayerEndpoint, participant name GStreamerFilter). Apart from the RtpEndpoint connected to the SIP client, all other RtpEndpoints correspond to a Mediasoup Producer or Consumer depending on it sending or receiving respectively. All Mediasoup audio Consumers connected to Kurento RtpEndpoints are sent into a Kurento Composite hub for mixing before the single audio stream is sent to the SIP caller. Only one Mediasoup video Consumer RtpEndpoint is sent to the SIP caller at any given time, and this is determined by speaker detection.

![multiparty-meeting-sipgw kurento architecture](https://raw.githubusercontent.com/havfo/multiparty-meeting-sipgw/master/doc/multiparty-meeting-sipgw-kurento.png "multiparty-meeting-sipgw kurento architecture")

## Installation

To run this gateway you will need several external components, install them according to their installation guides and your local requirements:
* [multiparty-meeting](https://github.com/havfo/multiparty-meeting)
* [drachtio-server](https://github.com/davehorton/drachtio-server)
* [Kurento server](https://doc-kurento.readthedocs.io/en/stable/user/installation.html)


Clone this project:

```bash
$ git clone https://github.com/havfo/multiparty-meeting-sipgw.git
$ cd multiparty-meeting-sipgw
```

Edit `config/default.json` with appropriate settings.

Install node modules:

```bash
$ npm install
```

## Run it

Run the Node.js server application in a terminal:

```bash
$ npm start
```

You can test it by calling: `roomname@yourdrachtioconfiguredsipdomain.com`

## Deploy it in a server

Stop your locally running server. Copy systemd-service file `multiparty-meeting-sipgw.service` to `/etc/systemd/system/` and check location path settings:

```bash
$ cp multiparty-meeting-sipgw.service /etc/systemd/system/
$ edit /etc/systemd/system/multiparty-meeting-sipgw.service
```

Reload SystemD configuration and start service:

```bash
$ systemctl daemon-reload
$ systemctl start multiparty-meeting-sipgw
```

If you want to start multiparty-meeting-sipgw at boot time:

```bash
$ systemctl enable multiparty-meeting-sipgw
```

## Author

* Håvar Aambø Fosstveit


## License

MIT



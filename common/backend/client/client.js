/*
 * client.js
 *
 * Manages the relationship between a socket-based socks5 _socksServer which passes
 * the requests over WebRTC datachannels to a give identity.
 */

//XXX: needed for chrome debugging, used by socks.js and tcp-server.js.
var window = {};
console.log('SOCKS5 client: ' + self.location.href);

window.socket = freedom['core.socket']();
var onload = function() {
  // The socks TCP Server.
  var _socksServer = null;
  // The Freedom sctp-peer connection.
  var _sctpPeer = null;
  // The signalling channel
  var _signallingChannel = null;
  // Each TcpConnection that is active, indexed by it's corresponding sctp
  // channel id.
  var _conns = {};

  // Stop running as a _socksServer. Close all connections both to data
  // channels and tcp.
  var shutdown = function() {
    if (_socksServer) {
      _socksServer.tcpServer.disconnect();
      _socksServer = null;
    }
    for (var channelId in _conns) {
      onClose(channelId, _conns[channelId]);
    }
    if(_sctpPeer) { _sctpPeer.shutdown(); }
    _conns = {};
    _sctpPeer = null;
    _signallingChannel = null;
  };

  // Close a particular tcp-connection and data channel pair.
  var closeConnection = function(channelId, conn) {
    conn.disconnect();
    _sctpPeer.closeDataChannel.bind(_sctpPeer, channelId);
    delete _conns[channelId];
  };

  // A SOCKS5 connection request has been received, setup the data channel and
  // start socksServering the corresponding tcp-connection to the data channel.
  var onConnection = function(conn, address, port, connectedCallback) {
    if (!_sctpPeer) {
      console.error("onConnection called without a _sctpPeer.");
      return;
    }

    // TODO: reuse tags from a pool.
    var channelId = "c" + Math.random();
    _conns[channelId] = conn.tcpConnection;

    // When the TCP-connection receives data, send it on the sctp peer on the corresponding channelId
    conn.tcpConnection.on('recv', _sctpPeer.send.bind(_sctpPeer, channelId));
    // When the TCP-connection closes
    conn.tcpConnection.on('disconnect', closeConnection.bind(null, channelId));

    _sctpPeer.send(channelId, JSON.stringify({host: address, port: port}));

    // TODO: we are not connected yet... should we have some message passing
    // back from the other end of the data channel to tell us when it has
    // happened, instead of just pretended?
    // TODO: determine if these need to be accurate.
    connectedCallback({ipAddrString: '127.0.0.1', port: 0});
  };

  freedom.on('start', function(options) {
    console.log('Cleint: on(start)...');
    shutdown();
    _socksServer = new window.SocksServer(options.host, options.port, onConnection);
    _socksServer.tcpServer.listen();

    // Create sctp connection to a peer.
    _sctpPeer = freedom['core.sctp-peerconnection']();
    _sctpPeer.on('onMessage', function(message) {
      if (message.channelId) {
        if (message.buffer) {
          _conns[message.channelId].sendRaw(message.buffer);
        } else if (message.text) {
          _conns[message.channelId].sendRaw(message.text);
        } else {
          console.error("Message type isn't specified properly. Msg: "
            + JSON.stringify(message));
        }
      } else {
        console.error("Message received but missing channelId. Msg: "
            + JSON.stringify(message));
      }
    });

    // When WebRTC data-channel transport is closed, shut everything down.
    _sctpPeer.on('onCloseDataChannel', closeConnection);

    // Create a freedom-channel to act as the signallin channel.
    var promise = freedom.core().createChannel();
    promise.done(function(chan) {  // When the signalling channel is created.
      // chan.identifier is a freedom-_socksServer (not a socks _socksServer) for the
      // signalling channel used for signalling.
      _sctpPeer.setup(chan.identifier, options, true);

      // when the channel is complete, setup handlers.
      chan.channel.done(function(signallingChannel) {
        _signallingChannel = signallingChannel;
        // when the signalling channel gets a message, send that message to the
        // freedom 'fromClient' handlers.
        _signallingChannel.on('message', function(msg) {
          freedom.emit('fromClient', { data: msg });
        });
        // When the signalling channel is ready, set the global variable.
        _signallingChannel.on('ready', function() {});
      });
    });
  });

  // Send any toClient freedom messages to the signalling channel.
  freedom.on('toClient', function(msg) {
    if (_signallingChannel) {
      _signallingChannel.emit('message', msg.data);
    } else {
      console.log("Couldn't route incoming signaling message");
    }
  });

  // If we get the 'stop' message, shutdown.
  freedom.on('stop', shutdown);

  // Setup completed, now emit the ready message.
  freedom.emit('ready', {});
};

//TODO(willscott): WebWorker startup errors are hard to debug.
// Once fixed, code can be executed synchronously.
setTimeout(onload, 0);


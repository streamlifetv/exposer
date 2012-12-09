var http = require('http');
var url = require('url');
var shoe = require('shoe');
var ecstatic = require('ecstatic')(__dirname + '/static');
var dnode = require('dnode');
var mongoose = require('mongoose');
var twitter = require('ntwitter');
var swig = require('swig');

var $ = require('jquery');

var PORT = process.env.PORT || '8000';
var SITE_URL = process.env.SITE_URL || 'http://127.0.0.1:8000';
var MONGODB_URL = process.env.MONGODB_URL || process.env.MONGOHQ_URL || 'mongodb://localhost/exposer';
var TWITTER_CONSUMER_KEY = process.env.TWITTER_CONSUMER_KEY;
var TWITTER_CONSUMER_SECRET = process.env.TWITTER_CONSUMER_SECRET;
var TWITTER_ACCESS_TOKEN_KEY = process.env.TWITTER_ACCESS_TOKEN_KEY;
var TWITTER_ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;
var TWITTER_QUERY = ['#gotofje', '#gotofsi', '#protesti', '@gotofsi', '@gotofje', '#gotoviso', '#mbprotest', '#ljprotest'];
var FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
var FACEBOOK_REALTIME_VERIFY_TOKEN = process.env.FACEBOOK_REALTIME_VERIFY_TOKEN;
var MAX_POSTS_PER_REQUEST = 50;

var db = mongoose.createConnection(MONGODB_URL).on('error', function (err) {
    // TODO: Handle
    console.error("MongoDB connection error: %s", err);
}).once('open', function () {
    console.log("MongoDB connection successful");
});

var schema = mongoose.Schema({
    'type': {
        'type': String,
        'required': true
    },
    'foreign_id': {
        'type': String,
        'unique': true,
        'required': true
    },
    'foreign_timestamp': {
        'type': Date,
        'index': true,
        'required': true
    },
    'data': {
        'type': mongoose.Schema.Types.Mixed,
        'required': true
    },
    'original_data': {
        'type': mongoose.Schema.Types.Mixed,
        'required': true
    }
});
var Post = db.model('Post', schema);

swig.init({
    'root': __dirname + '/templates'
});

var facebookTemplate = swig.compileFile('facebook.html');

var server = http.createServer(function (request, response) {
    var request_url = url.parse(request.url, true);
    switch (request_url.pathname) {
        case '/facebook.html':
            response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            response.write(facebookTemplate.render({
                'FACEBOOK_APP_ID': FACEBOOK_APP_ID,
                'SITE_URL': SITE_URL
            }));
            response.end();
            break;
        case '/fb/realtime':
            if (request.method.toLowerCase() === 'post') {
                var data = '';
                request.setEncoding('utf8');
                request.addListener('data', function (chunk) {
                    data += chunk;
                }).addListener('end', function () {
                    response.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
                    response.end();

                    console.log("Facebook realtime payload");
                    console.log(data);
                });
            }
            else {
                // TODO: Check X-Hub-Signature

                console.log("Facebook realtime subscription");

                if ((request_url.query['hub.mode'] !== 'subscribe') || (request_url.query['hub.verify_token'] !== FACEBOOK_REALTIME_VERIFY_TOKEN)) {
                    response.writeHead(400);
                    response.end();
                    return;
                }

                response.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
                response.write(request_url.query['hub.challenge']);
                response.end();
            }
            break;
        default:
            ecstatic(request, response);
            break;
    }
});
server.listen(PORT);

// TODO: This should be distributed if we will have multiple instances
var clients = [];

var sock = shoe(function (stream) {
    var d = dnode({
        'getPosts': function (start, limit, cb) {
            limit = parseInt(limit) || MAX_POSTS_PER_REQUEST;
            if ((limit <= 0) || (limit > MAX_POSTS_PER_REQUEST)) {
                limit = MAX_POSTS_PER_REQUEST;
            }
            // TODO: Implement support for start
            // TODO: Once implemented, make client load new posts when it scrolls to the end of the page
			Post.find({}, {'type': true, 'foreign_id': true, 'foreign_timestamp': true, 'data': true}).sort({'foreign_timestamp': 'desc'}).limit(limit).lean(true).exec(function (err, posts) {
				if (err) {
					cb(err);
                    return;
				}

                posts = $.map(posts, function (post, i) {
                    post.fetch_timestamp = post._id.getTimestamp();
                    delete post._id;
                    return post;
                });

				cb(null, posts);
			});
        }
    });
    d.on('remote', function (remote, d) {
        clients.push(remote);
    }).on('end', function () {
        // TODO: We should clean connections, too
        // https://github.com/substack/dnode/pull/111
    }).pipe(stream).pipe(d);
});

sock.install(server, '/dnode');

var twit = new twitter({
    'consumer_key': TWITTER_CONSUMER_KEY,
    'consumer_secret': TWITTER_CONSUMER_SECRET,
    'access_token_key': TWITTER_ACCESS_TOKEN_KEY,
    'access_token_secret': TWITTER_ACCESS_TOKEN_SECRET
});

function storeTweet(tweet) {
    var t = {'foreign_id': tweet.id_str, 'type': 'twitter'};
    var foreign_timestamp = new Date(tweet.created_at);
    var data = {
        'from_user': tweet.from_user || tweet.user.screen_name,
        'in_reply_to_status_id': tweet.in_reply_to_status_id,
        'text': tweet.text
    };

    Post.findOneAndUpdate(t, {'foreign_timestamp': foreign_timestamp, 'data': data, 'original_data': tweet}, {'upsert': true, 'new': false}, function (err, obj) {
        if (err) {
            console.error("Twitter post (%s) store error: %s", tweet.id_str, err);
            return;
        }

        if (!obj.toObject()) {
            // Tweet was not already stored
            // We reconstruct object as it is stored in the database, because to if
            // tweet was stored or not we do not fetch new a object from the database
            t.foreign_timestamp = foreign_timestamp;
            t.data = data;

            t.fetch_timestamp = new Date(); // We fake here a bit

            $.each(clients, function (i, client) {
                client.newPost(t);
            });
        }
    });
}

function connectToTwitterStream() {
    console.log("Twitter stream connecting");
    twit.stream('statuses/filter', {'track': TWITTER_QUERY}, function (stream) {
        console.log("Twitter stream connected");
        stream.on('data', function (data) {
            storeTweet(data);
        }).on('delete', function (data) {
            // TODO: Implement (https://dev.twitter.com/docs/streaming-apis/messages)
            console.log("Twitter delete: %s", data);
        }).on('scrub_geo', function (data) {
            // TODO: Implement (https://dev.twitter.com/docs/streaming-apis/messages)
            console.log("Twitter scrub_geo: %s", data);
        }).on('end', function (response) {
            console.warn("Twitter stream disconnected: %s", response);
            // TODO: Back-off
            connectToTwitterStream();
        }).on('destroy', function (response) {
            console.warn("Twitter stream disconnected: %s", response);
            // TODO: Back-off
            connectToTwitterStream();
        });
    });
}

// We use both count and rpp to be compatibile with various Twitter API versions (and older ntwitter versions)
twit.search(TWITTER_QUERY.join(' OR '), {'include_entities': true, 'count': 100, 'rpp': 100}, function(err, data) {
    if (err) {
        console.error("Twitter search error: %s", err);
        return;
    }

    $.each(data.results, function (i, tweet) {
        storeTweet(tweet);
    });
});

connectToTwitterStream();

var mongoose = require('mongoose');

var $ = require('jquery');

var settings = require('./settings');

var db = mongoose.createConnection(settings.MONGODB_URL).on('error', function (err) {
    console.error("MongoDB connection error: %s", err);
    // TODO: Handle better, depending on the error?
    throw new Error("MongoDB connection error");
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
        'required': false
    },
    'additional_data': {
        'type': mongoose.Schema.Types.Mixed,
        'required': false
    }
});
var Post = db.model('Post', schema);

var postNotFiltered = " \
    function () { \
        function regexMatch(obj) { \
            for (var field in obj) { \
                if (obj.hasOwnProperty(field)) { \
                    if (/" + settings.FACEBOOK_QUERY.join('|') + "/i.test(obj[field])) { \
                        return true; \
                    } \
                    if (typeof(obj[field]) === 'object' && regexMatch(obj[field])) { \
                        return true; \
                    } \
                } \
            } \
            return false; \
        } \
        if (this.type === 'facebook') { \
            return regexMatch(this); \
        } \
        else { \
            return true; \
        } \
    } \
"

function storePost(foreign_id, type, foreign_timestamp, data, original_data, callback) {
    var query = {'foreign_id': foreign_id, 'type': type};
    Post.findOneAndUpdate(query, {'foreign_timestamp': foreign_timestamp, 'data': data, 'original_data': original_data}, {'upsert': true, 'new': false}, function (err, obj) {
        if (err) {
            console.error("Post (%s/%s) store error: %s", type, foreign_id, err);
            return;
        }

        if (!obj.toObject()) {
            // Post was not already stored
            // We load post manually, because to know if post was stored or not we
            // do not set "new" parameter of findOneAndUpdate call
            Post.findOne($.extend({}, {'$where': postNotFiltered}, settings.POSTS_FILTER, query), {'type': true, 'foreign_id': true, 'foreign_timestamp': true, 'data': true, 'additional_data': true}).lean(true).exec(function (err, post) {
                if (err) {
                    console.error("Post (%s/%s) load error: %s", type, foreign_id, err);
                    return;
                }
                if (!post) {
                    // Filtered out
                    return;
                }

                post.fetch_timestamp = post._id.getTimestamp();
                delete post._id;

                if (callback) {
                    callback(post);
                }
            });
        }
    });
}

function storeTweet(tweet, callback) {
    var data = {
        'from_user': tweet.from_user || tweet.user.screen_name,
        'in_reply_to_status_id': tweet.in_reply_to_status_id,
        'in_reply_to_status_id_str': tweet.in_reply_to_status_id_str,
        'text': tweet.text
    };

    storePost(tweet.id_str, 'twitter', new Date(tweet.created_at), data, tweet, callback);
}

function storeFacebookPost(post, callback) {
    storePost(post.id, 'facebook', new Date(post.created_time), post, null, callback);
}

exports.Post = Post;
exports.storeTweet = storeTweet;
exports.storeFacebookPost = storeFacebookPost;
exports.postNotFiltered = postNotFiltered;

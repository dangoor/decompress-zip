'use strict';

// The zip file spec is at http://www.pkware.com/documents/casestudies/APPNOTE.TXT
// TODO: There is fair chunk of the spec that I have ignored. Need to add
// assertions everywhere to make sure that we are not dealing with a ZIP type
// that I haven't designed for. Things like spanning archives, non-DEFLATE
// compression, encryption, etc.
var fs = require('fs');
var Q = require('q');
var path = require('path');
var util = require('util');
var events = require('events');
var structures = require('./structures');
var signatures = require('./signatures');
var extractors = require('./extractors');

// Denodify some node lib methods

var fstat = Q.denodeify(fs.fstat);
var read = Q.denodeify(fs.read);
var fopen = Q.denodeify(fs.open);

// Class definition

function DecompressZip(filename) {
    events.EventEmitter.call(this);

    this.filename = filename;
    this.stats = null;
    this.fd = null;
    this.chunkSize = 1024 * 1024; // Buffer up to 1Mb at a time

    // When we need a resource, we should check if there is a promise for it
    // already and use that. If the promise is already fulfilled we don't do the
    // async work again and we get to queue up dependant tasks.
    this._p = {}; // _p instead of _promises because it is a lot easier to read
}

util.inherits(DecompressZip, events.EventEmitter);

DecompressZip.version = require('../package.json').version;

DecompressZip.prototype.openFile = function () {
    return fopen(this.filename, 'r');
};

DecompressZip.prototype.statFile = function (fd) {
    this.fd = fd;
    return fstat(fd);
};

DecompressZip.prototype.list = function () {
    var self = this;

    this.getFiles()
    .then(function (files) {
        var result = [];

        files.forEach(function (file) {
            result.push(file.name);
        });

        self.emit('list', result);
    })
    .fail(function (error) {
        self.emit('error', error);
    });

    return this;
};

DecompressZip.prototype.extract = function (options) {
    var self = this;

    options = options || {};
    options.path = options.path || '.';

    this.getFiles()
    .then(function (files) {
        var promises = [];
        var results = [];

        files.forEach(function (file) {
            var promise = self._extract(file, options.path)
            .then(function (result) {
                results.push(result);
            });

            promises.push(promise);
        });

        return Q.all(promises)
        .then(function () {
            self.emit('extract', results);
        });
    })
    .fail(function (error) {
        self.emit('error', error);
    });

    return this;
};

// Utility methods
DecompressZip.prototype.getSearchBuffer = function (stats) {
    var size = Math.min(stats.size, this.chunkSize);
    this.stats = stats;
    return this.getBuffer(stats.size - size, stats.size);
};

DecompressZip.prototype.getBuffer = function (start, end) {
    var size = end - start;
    return read(this.fd, new Buffer(size), 0, size, start)
    .then(function (result) {
        return result[1];
    });
};

DecompressZip.prototype.findEndOfDirectory = function (buffer) {
    var index = buffer.length - 3;
    var chunk = '';

    // Apparently the ZIP spec is not very good and it is impossible to
    // guarantee that you have read a zip file correctly, or to determine
    // the location of the CD without hunting.
    // Search backwards through the buffer, as it is very likely to be near the
    // end of the file.
    while (index > Math.max(buffer.length - this.chunkSize, 0) && chunk !== signatures.END_OF_CENTRAL_DIRECTORY) {
        index--;
        chunk = buffer.readUInt32LE(index);
    }

    if (chunk !== signatures.END_OF_CENTRAL_DIRECTORY) {
        throw new Error('Could not find the End of Central Directory Record');
    }

    return buffer.slice(index);
};

// Directory here means the ZIP Central Directory, not a folder
DecompressZip.prototype.readDirectory = function (recordBuffer) {
    var record = structures.readEndRecord(recordBuffer);

    return this.getBuffer(record.directoryOffset, record.directoryOffset + record.directorySize)
    .then(structures.readDirectory.bind(null));
};

DecompressZip.prototype.getFiles = function () {
    if (!this._p.getFiles) {
        this._p.getFiles = this.openFile()
        .then(this.statFile.bind(this))
        .then(this.getSearchBuffer.bind(this))
        .then(this.findEndOfDirectory.bind(this))
        .then(this.readDirectory.bind(this))
        .then(this.readFileEntries.bind(this));
    }

    return this._p.getFiles;
};

DecompressZip.prototype.readFileEntries = function (directory) {
    var promises = [];
    var files = [];
    var self = this;

    directory.forEach(function (directoryEntry, index) {
        var start = directoryEntry.relativeOffsetOfLocalHeader;
        var end = Math.min(self.stats.size, start + structures.maxFileEntrySize);

        var promise = self.getBuffer(start, end)
        .then(structures.readFileEntry.bind(null))
        .then(function (fileEntry) {
            var maxSize = self.stats.size;

            if (index < directory.length - 1) {
                maxSize = directory[index + 1].relativeOffsetOfLocalHeader;
            }

            maxSize -= start + fileEntry.entryLength;

            files[index] = {
                name: directoryEntry.fileName,
                directoryEntry: directoryEntry,
                fileEntry: fileEntry,
                dataOffset: start + fileEntry.entryLength,
                maxSize: maxSize
            };

            self.emit('file', files[index]);
        });

        promises.push(promise);
    });

    return Q.all(promises)
    .then(function () {
        return files;
    });
};

DecompressZip.prototype._extract = function (file, destination) {
    destination = path.join(destination, file.name);

    // TODO: This actually needs to come from the externalAttributes
    if (file.name.substr(-1) === '/') {
        return extractors.folder(file, destination);
    }

    // Possible compression methods:
    //    0 - The file is stored (no compression)
    //    1 - The file is Shrunk
    //    2 - The file is Reduced with compression factor 1
    //    3 - The file is Reduced with compression factor 2
    //    4 - The file is Reduced with compression factor 3
    //    5 - The file is Reduced with compression factor 4
    //    6 - The file is Imploded
    //    7 - Reserved for Tokenizing compression algorithm
    //    8 - The file is Deflated
    //    9 - Enhanced Deflating using Deflate64(tm)
    //   10 - PKWARE Data Compression Library Imploding (old IBM TERSE)
    //   11 - Reserved by PKWARE
    //   12 - File is compressed using BZIP2 algorithm
    //   13 - Reserved by PKWARE
    //   14 - LZMA (EFS)
    //   15 - Reserved by PKWARE
    //   16 - Reserved by PKWARE
    //   17 - Reserved by PKWARE
    //   18 - File is compressed using IBM TERSE (new)
    //   19 - IBM LZ77 z Architecture (PFS)
    //   97 - WavPack compressed data
    //   98 - PPMd version I, Rev 1

    switch (file.directoryEntry.compressionMethod) {
    case 0:
        return extractors.store(file, destination, this);

    case 8:
        return extractors.deflate(file, destination, this);

    default:
        throw new Error('Unsupported compression type');
    }
};


module.exports = DecompressZip;

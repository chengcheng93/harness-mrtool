const originalWrite = process.stdout.write.bind(process.stdout);

process.stdout.write = function delayedWrite(chunk, encoding, callback) {
  setTimeout(() => originalWrite(chunk, encoding, callback), 25);
  return false;
};

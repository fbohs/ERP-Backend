when uploading products data
  - first add all data apart from image to db and return a hashed string which maps to this newly added id ( not uuid but id for fast lookup )
  - then this hashed string is sent to frontend to be maintained as "idempotency key" for handling media upload for this product
  - then request presigned url for client upload to s3 bucket using this "idempotency key" to upload image to s3 bucket with proper naming convention(involving variant sku and etc)
  - then client will upload image to s3 bucket
  - after image upload client send s3 object key to backend using webhook
  - meanwhile this, frontend also caches image uploaded and only changes on refresh or next visits
  - and backend will save it to db
  - we can use worker thread for this 
  - also send proper error response to client if image upload fails

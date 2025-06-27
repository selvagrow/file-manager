const formidable = require('formidable');
const { 
  authenticateHybrid, 
  handleCors, 
  errorResponse, 
  successResponse 
} = require('./utils');
const { putObject } = require('./r2-client');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return errorResponse(res, 405, 'Method not allowed');
  }

  try {
    // Authenticate using hybrid authentication (supports both API key and JWT session)
    const { user, newAccessToken } = authenticateHybrid(req);
    
    // Set new access token if JWT was refreshed
    if (newAccessToken) {
      const { setCookie } = require('./utils');
      const accessCookie = setCookie('accessToken', newAccessToken, { maxAge: 15 * 60 });
      res.setHeader('Set-Cookie', accessCookie);
    }
    
    // Parse form data
    const form = new formidable.IncomingForm({
      maxFileSize: 4 * 1024 * 1024, // 4MB for Vercel Hobby compatibility  
      maxFiles: 10
    });
    
    const [fields, files] = await form.parse(req);
    
    if (!files.files || files.files.length === 0) {
      return errorResponse(res, 400, 'No files uploaded', 'Please provide files in the "files" field');
    }
    
    const fileArray = Array.isArray(files.files) ? files.files : [files.files];
    const uploadResults = [];
    const errors = [];
    
    for (const file of fileArray) {
      try {
        // Validate file
        if (!file.size || file.size === 0) {
          errors.push({ file: file.originalFilename || file.name, error: 'Empty file' });
          continue;
        }
        
        // Generate filename with timestamp and random suffix
        const timestamp = Date.now();
        const randomSuffix = Math.random().toString(36).substring(2, 8);
        const originalName = file.originalFilename || file.name || 'unknown';
        const filename = `${timestamp}-${randomSuffix}-${originalName}`;
        
        // Read file buffer
        const fs = require('fs');
        const fileBuffer = fs.readFileSync(file.filepath);
        
        // Upload to R2
        await putObject({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: filename,
          Body: fileBuffer,
          ContentType: file.mimetype || 'application/octet-stream',
        });
        
        // Build file URLs
        const baseUrl = process.env.R2_PUBLIC_URL || '';
        const publicUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/${filename}` : null;
        const downloadUrl = `/r2/download/${filename}`;
        
        uploadResults.push({
          filename: filename,
          originalName: originalName,
          key: filename,
          size: file.size,
          contentType: file.mimetype || 'application/octet-stream',
          publicUrl: publicUrl,
          downloadUrl: downloadUrl,
          uploadedAt: new Date().toISOString()
        });
      } catch (uploadError) {
        errors.push({ 
          file: file.originalFilename || file.name, 
          error: uploadError.message 
        });
      }
    }
    
    return successResponse(res, {
      uploaded: uploadResults,
      errors: errors,
      summary: {
        total: fileArray.length,
        successful: uploadResults.length,
        failed: errors.length
      }
    }, `${uploadResults.length} files uploaded successfully${errors.length > 0 ? `, ${errors.length} failed` : ''}`);
    
  } catch (error) {
    console.error('API Multiple upload error:', error);
    if (error.message.includes('API key') || error.message.includes('token') || error.message.includes('authenticate')) {
      return errorResponse(res, 401, error.message);
    }
    return errorResponse(res, 500, 'Upload failed', error.message);
  }
}

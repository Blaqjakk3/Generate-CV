const { Client, Databases, Query } = require('node-appwrite');
const PDFDocument = require('pdfkit');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize client with proper server-side configuration
const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY); 

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

module.exports = async ({ req, res, log, error }) => {
    try {
        log('Starting CV generation...');
        
        const { talentId, additionalSkills = [], educationDetails = [], workExperiences = [], additionalEducation = [] } = JSON.parse(req.body);

        if (!talentId) {
            return res.json({ success: false, error: 'talentId is required' }, 400);
        }

        log(`Fetching talent data for ID: ${talentId}`);

        // Try to fetch talent data with error handling
        let talentQuery;
        try {
            talentQuery = await databases.listDocuments(
                'career4me',
                'talents',
                [Query.equal('talentId', talentId)]
            );
            log(`Query successful. Found ${talentQuery.documents.length} documents`);
        } catch (dbError) {
            error('Database query failed:', dbError);
            
            // Check if it's an authentication error
            if (dbError.message.includes('not authorized')) {
                return res.json({ 
                    success: false, 
                    error: 'Database access not authorized. Please check function and collection permissions.',
                    details: 'The function needs read access to the talents collection'
                }, 403);
            }
            
            throw dbError;
        }

        if (talentQuery.documents.length === 0) {
            return res.json({ success: false, error: 'Talent not found' }, 404);
        }

        const talent = talentQuery.documents[0];
        log(`Found talent: ${talent.fullname}`);

        // Combine skills
        const existingSkills = talent.skills || [];
        const allSkills = [...existingSkills, ...additionalSkills];

        // Generate professional summary using Gemini
        log('Generating professional summary...');
        // Updated model name - using gemini-1.5-flash which is stable and widely available
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const summaryPrompt = `Generate a professional summary for a CV based on the following information:
        - Career Stage: ${talent.careerStage}
        - Skills: ${allSkills.join(', ')}
        - Interests: ${(talent.interests || []).join(', ')}
        - Selected Path: ${talent.selectedPath || 'Not specified'}
        - Work Experiences: ${workExperiences.map(exp => `${exp.position} at ${exp.company}`).join(', ')}
        
        Create a 3-4 sentence professional summary that highlights their strengths and career focus. Make it compelling and professional.`;

        const summaryResult = await model.generateContent(summaryPrompt);
        const professionalSummary = summaryResult.response.text();

        log('Generating PDF...');
        // Generate PDF
        const pdfBuffer = await generatePDF({
            talent,
            allSkills,
            educationDetails,
            workExperiences,
            additionalEducation,
            professionalSummary
        });

        // Convert to base64
        const base64PDF = pdfBuffer.toString('base64');

        log('CV generation completed successfully');
        return res.json({
            success: true,
            pdfData: base64PDF,
            metadata: {
                talentName: talent.fullname,
                generatedAt: new Date().toISOString(),
                sections: ['Personal Info', 'Professional Summary', 'Education', 'Work Experience', 'Skills', 'Certifications', 'Interests']
            }
        });

    } catch (err) {
        error('CV generation failed:', err);
        return res.json({ 
            success: false, 
            error: err.message || 'Failed to generate CV',
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }, 500);
    }
};

async function generatePDF({ talent, allSkills, educationDetails, workExperiences, additionalEducation, professionalSummary }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            resolve(pdfData);
        });
        doc.on('error', reject);

        // Header
        doc.fontSize(24).font('Times-Bold').text(talent.fullname, { align: 'center' });
        doc.fontSize(12).font('Times-Roman').text(talent.email, { align: 'center' });
        doc.moveDown(1);

        // Professional Summary
        doc.fontSize(16).font('Times-Bold').text('Professional Summary');
        doc.fontSize(12).font('Times-Roman').text(professionalSummary, { align: 'justify' });
        doc.moveDown(1);

        // Education
        doc.fontSize(16).font('Times-Bold').text('Education');
        
        // Existing degrees
        if (talent.degrees && talent.degrees.length > 0) {
            talent.degrees.forEach(degree => {
                doc.fontSize(14).font('Times-Bold').text(degree);
                doc.moveDown(0.5);
            });
        }

        // Education details
        educationDetails.forEach(edu => {
            doc.fontSize(14).font('Times-Bold').text(edu.degree || 'Degree');
            doc.fontSize(12).font('Times-Roman').text(`${edu.institution} | ${edu.startDate} - ${edu.endDate}`);
            doc.moveDown(0.5);
        });

        // Additional education
        additionalEducation.forEach(edu => {
            doc.fontSize(14).font('Times-Bold').text(edu.title || 'Additional Education');
            doc.fontSize(12).font('Times-Roman').text(`${edu.institution} | ${edu.year}`);
            doc.moveDown(0.5);
        });
        
        doc.moveDown(1);

        // Work Experience
        if (workExperiences.length > 0) {
            doc.fontSize(16).font('Times-Bold').text('Work Experience');
            
            workExperiences.forEach(exp => {
                doc.fontSize(14).font('Times-Bold').text(`${exp.position} - ${exp.company}`);
                doc.fontSize(12).font('Times-Roman').text(`${exp.startDate} - ${exp.endDate}`);
                if (exp.description) {
                    doc.text(exp.description, { align: 'justify' });
                }
                doc.moveDown(0.5);
            });
            doc.moveDown(1);
        }

        // Skills
        if (allSkills.length > 0) {
            doc.fontSize(16).font('Times-Bold').text('Skills');
            doc.fontSize(12).font('Times-Roman').text(allSkills.join(' • '));
            doc.moveDown(1);
        }

        // Certifications
        if (talent.certifications && talent.certifications.length > 0) {
            doc.fontSize(16).font('Times-Bold').text('Certifications');
            talent.certifications.forEach(cert => {
                doc.fontSize(12).font('Times-Roman').text(`• ${cert}`);
            });
            doc.moveDown(1);
        }

        // Interests
        if (talent.interests && talent.interests.length > 0) {
            doc.fontSize(16).font('Times-Bold').text('Interests');
            doc.fontSize(12).font('Times-Roman').text(talent.interests.join(' • '));
        }

        doc.end();
    });
}
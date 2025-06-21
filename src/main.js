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
        
        const { 
            talentId, 
            additionalSkills = [], 
            educationDetails = [], 
            workExperiences = [], 
            projects = [],
            certifications = [],
            contactInfo = {}
        } = JSON.parse(req.body);

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

        // Combine skills - avoid duplicates
        const existingSkills = talent.skills || [];
        const combinedSkills = [...new Set([...existingSkills, ...additionalSkills])];

        // Filter out empty or invalid entries
        const validEducation = educationDetails.filter(edu => 
            edu && edu.degree && edu.degree.trim() && edu.institution && edu.institution.trim()
        );
        
        const validWorkExperience = workExperiences.filter(exp => 
            exp && exp.company && exp.company.trim() && exp.position && exp.position.trim()
        );
        
        const validProjects = projects.filter(proj => 
            proj && proj.title && proj.title.trim() && proj.description && proj.description.trim()
        );
        
        const validCertifications = certifications.filter(cert => 
            cert && cert.title && cert.title.trim() && cert.issuer && cert.issuer.trim()
        );

        // Generate professional summary using Gemini
        log('Generating professional summary...');
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const summaryPrompt = `Generate a professional summary for a CV based on the following information:
        - Name: ${talent.fullname}
        - Career Stage: ${talent.careerStage}
        - Skills: ${combinedSkills.join(', ')}
        - Interests: ${(talent.interests || []).join(', ')}
        - Selected Path: ${talent.selectedPath || 'Not specified'}
        - Work Experiences: ${workExperiences.map(exp => `${exp.position} at ${exp.company}`).join(', ')}
        - Projects: ${projects.map(proj => proj.title).join(', ')}
        
        Create a compelling 3-4 sentence professional summary that highlights their strengths, career focus, and key achievements. Make it professional and engaging.`;

        const summaryResult = await model.generateContent(summaryPrompt);
        const professionalSummary = summaryResult.response.text();

        log('Generating PDF...');
        // Generate PDF
        const pdfBuffer = await generatePDF({
            talent,
            combinedSkills,
            educationDetails: validEducation,
            workExperiences: validWorkExperience,
            projects: validProjects,
            certifications: validCertifications,
            contactInfo,
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
                sections: ['Personal Info', 'Professional Summary', 'Education', 'Work Experience', 'Projects', 'Skills', 'Certifications', 'Contact Information']
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

async function generatePDF({ talent, combinedSkills, educationDetails, workExperiences, projects, certifications, contactInfo, professionalSummary }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ 
            margin: 50,
            size: 'A4'
        });
        const buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            resolve(pdfData);
        });
        doc.on('error', reject);

        let yPosition = 50;

        // Header with Name
        doc.fontSize(28).font('Helvetica-Bold').text(talent.fullname.toUpperCase(), 50, yPosition, { align: 'center' });
        yPosition += 40;

        // Contact Information Line
        const contactLine = [];
        if (talent.email) contactLine.push(talent.email);
        if (contactInfo.phone) contactLine.push(contactInfo.phone);
        if (contactInfo.linkedin) contactLine.push(`LinkedIn: ${contactInfo.linkedin}`);
        if (contactInfo.github) contactLine.push(`GitHub: ${contactInfo.github}`);
        if (contactInfo.portfolio) contactLine.push(`Portfolio: ${contactInfo.portfolio}`);

        if (contactLine.length > 0) {
            doc.fontSize(11).font('Helvetica').text(contactLine.join(' | '), 50, yPosition, { align: 'center' });
            yPosition += 30;
        }

        // Add a horizontal line
        doc.moveTo(50, yPosition).lineTo(550, yPosition).stroke();
        yPosition += 20;

        // Professional Summary Section
        if (professionalSummary) {
            doc.fontSize(16).font('Helvetica-Bold').text('PROFESSIONAL SUMMARY', 50, yPosition);
            yPosition += 20;
            doc.fontSize(11).font('Helvetica').text(professionalSummary, 50, yPosition, { 
                width: 500, 
                align: 'justify' 
            });
            yPosition += doc.heightOfString(professionalSummary, { width: 500 }) + 20;
        }

        // Education Section
        if (educationDetails && educationDetails.length > 0) {
            // Check if we need a new page
            if (yPosition > 700) {
                doc.addPage();
                yPosition = 50;
            }

            doc.fontSize(16).font('Helvetica-Bold').text('EDUCATION', 50, yPosition);
            yPosition += 20;

            educationDetails.forEach((edu) => {
                // Check if we need a new page for each education entry
                if (yPosition > 720) {
                    doc.addPage();
                    yPosition = 50;
                }

                doc.fontSize(12).font('Helvetica-Bold').text(edu.degree, 50, yPosition);
                yPosition += 15;
                
                doc.fontSize(11).font('Helvetica-Oblique').text(edu.institution, 50, yPosition);
                if (edu.location) {
                    doc.text(` • ${edu.location}`, { continued: true });
                }
                yPosition += 15;
                
                if (edu.startDate || edu.endDate) {
                    const dateRange = `${edu.startDate || ''} - ${edu.endDate || 'Present'}`;
                    doc.fontSize(10).font('Helvetica').text(dateRange, 50, yPosition);
                    yPosition += 20;
                } else {
                    yPosition += 10;
                }
            });
        }

        // Work Experience Section
        if (workExperiences && workExperiences.length > 0) {
            // Check if we need a new page
            if (yPosition > 650) {
                doc.addPage();
                yPosition = 50;
            }

            doc.fontSize(16).font('Helvetica-Bold').text('WORK EXPERIENCE', 50, yPosition);
            yPosition += 20;

            workExperiences.forEach((exp) => {
                // Check if we need a new page for each experience
                if (yPosition > 600) {
                    doc.addPage();
                    yPosition = 50;
                }

                doc.fontSize(12).font('Helvetica-Bold').text(exp.position, 50, yPosition);
                yPosition += 15;
                
                doc.fontSize(11).font('Helvetica-Oblique').text(exp.company, 50, yPosition);
                if (exp.location) {
                    doc.text(` • ${exp.location}`, { continued: true });
                }
                yPosition += 15;
                
                if (exp.startDate || exp.endDate) {
                    const dateRange = `${exp.startDate || ''} - ${exp.endDate || 'Present'}`;
                    doc.fontSize(10).font('Helvetica').text(dateRange, 50, yPosition);
                    yPosition += 15;
                }
                
                if (exp.description) {
                    doc.fontSize(10).font('Helvetica').text(exp.description, 50, yPosition, { 
                        width: 500, 
                        align: 'justify' 
                    });
                    yPosition += doc.heightOfString(exp.description, { width: 500 }) + 20;
                } else {
                    yPosition += 10;
                }
            });
        }

        // Projects Section
        if (projects && projects.length > 0) {
            // Check if we need a new page
            if (yPosition > 650) {
                doc.addPage();
                yPosition = 50;
            }

            doc.fontSize(16).font('Helvetica-Bold').text('PROJECTS', 50, yPosition);
            yPosition += 20;

            projects.forEach((project) => {
                // Check if we need a new page for each project
                if (yPosition > 600) {
                    doc.addPage();
                    yPosition = 50;
                }

                doc.fontSize(12).font('Helvetica-Bold').text(project.title, 50, yPosition);
                yPosition += 15;
                
                if (project.description) {
                    doc.fontSize(10).font('Helvetica').text(project.description, 50, yPosition, { 
                        width: 500, 
                        align: 'justify' 
                    });
                    yPosition += doc.heightOfString(project.description, { width: 500 }) + 10;
                }
                
                if (project.technologies) {
                    doc.fontSize(10).font('Helvetica-Bold').text('Technologies: ', 50, yPosition, { continued: true });
                    doc.font('Helvetica').text(project.technologies);
                    yPosition += 15;
                }
                
                if (project.link) {
                    doc.fontSize(10).font('Helvetica').text(`Link: ${project.link}`, 50, yPosition, {
                        link: project.link,
                        underline: true
                    });
                    yPosition += 15;
                }

                // Project details/achievements
                if (project.details && project.details.length > 0) {
                    project.details.forEach((detail) => {
                        if (detail.trim()) {
                            doc.fontSize(10).font('Helvetica').text(`• ${detail}`, 60, yPosition, { width: 490 });
                            yPosition += doc.heightOfString(`• ${detail}`, { width: 490 }) + 5;
                        }
                    });
                }
                
                yPosition += 15;
            });
        }

        // Skills Section
        if (combinedSkills && combinedSkills.length > 0) {
            // Check if we need a new page
            if (yPosition > 720) {
                doc.addPage();
                yPosition = 50;
            }

            doc.fontSize(16).font('Helvetica-Bold').text('TECHNICAL SKILLS', 50, yPosition);
            yPosition += 20;
            
            const skillsText = combinedSkills.join(' • ');
            doc.fontSize(11).font('Helvetica').text(skillsText, 50, yPosition, { 
                width: 500, 
                align: 'justify' 
            });
            yPosition += doc.heightOfString(skillsText, { width: 500 }) + 20;
        }

        // Certifications Section
        if (certifications && certifications.length > 0) {
            // Check if we need a new page
            if (yPosition > 650) {
                doc.addPage();
                yPosition = 50;
            }

            doc.fontSize(16).font('Helvetica-Bold').text('CERTIFICATIONS & ACHIEVEMENTS', 50, yPosition);
            yPosition += 20;

            certifications.forEach((cert) => {
                // Check if we need a new page for each certification
                if (yPosition > 720) {
                    doc.addPage();
                    yPosition = 50;
                }

                doc.fontSize(11).font('Helvetica-Bold').text(cert.title, 50, yPosition);
                yPosition += 15;
                
                doc.fontSize(10).font('Helvetica-Oblique').text(cert.issuer, 50, yPosition);
                if (cert.date) {
                    doc.text(` • ${cert.date}`, { continued: true });
                }
                yPosition += 15;
                
                if (cert.link) {
                    doc.fontSize(10).font('Helvetica').text(`Link: ${cert.link}`, 50, yPosition, {
                        link: cert.link,
                        underline: true
                    });
                    yPosition += 20;
                } else {
                    yPosition += 10;
                }
            });
        }

        // Interests Section (if available)
        if (talent.interests && talent.interests.length > 0) {
            // Check if we need a new page
            if (yPosition > 720) {
                doc.addPage();
                yPosition = 50;
            }

            doc.fontSize(16).font('Helvetica-Bold').text('INTERESTS', 50, yPosition);
            yPosition += 20;
            
            const interestsText = talent.interests.join(' • ');
            doc.fontSize(11).font('Helvetica').text(interestsText, 50, yPosition, { 
                width: 500, 
                align: 'justify' 
            });
        }

        doc.end();
    });
}
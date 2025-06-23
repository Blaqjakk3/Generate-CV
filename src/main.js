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

        // Fetch career path details if selectedPath exists
        let careerPath = null;
        if (talent.selectedPath) {
            try {
                log(`Fetching career path details for ID: ${talent.selectedPath}`);
                const careerPathDoc = await databases.getDocument(
                    'career4me',
                    'careerPaths', 
                    talent.selectedPath
                );
                careerPath = careerPathDoc;
                log(`Found career path: ${careerPath.title}`);
            } catch (pathError) {
                error('Failed to fetch career path:', pathError);
                // Continue without career path data - we'll use fallback
            }
        }

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

        // Generate professional summary using Gemini with enhanced context
        log('Generating professional summary...');
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        
        // Build comprehensive context for the summary
        const careerStage = talent.careerStage || 'Pathfinder';
        const keySkills = combinedSkills.slice(0, 6); // Top 6 skills
        const hasExperience = validWorkExperience.length > 0;
        const hasProjects = validProjects.length > 0;
        const hasCertifications = validCertifications.length > 0;
        const hasEducation = validEducation.length > 0;
        
        // Career stage context for better summary
        const getCareerStageContext = (stage) => {
            switch (stage) {
                case 'Pathfinder':
                    return {
                        description: 'Someone finding their feet in career life, looking for their career and learning',
                        tone: 'eager to learn, motivated, entry-level focused',
                        focus: 'learning potential, foundational skills, enthusiasm'
                    };
                case 'Trailblazer':
                    return {
                        description: 'Someone with a career looking to continue growth',
                        tone: 'experienced, growth-oriented, seeking advancement',
                        focus: 'proven experience, leadership potential, continuous improvement'
                    };
                case 'Horizon Changer':
                    return {
                        description: 'Someone in a career path looking to pivot to another',
                        tone: 'transitioning, leveraging transferable skills, adaptive',
                        focus: 'transferable skills, adaptability, career transition goals'
                    };
                default:
                    return {
                        description: 'Professional seeking career development',
                        tone: 'professional, adaptable',
                        focus: 'skills and experience'
                    };
            }
        };

        const stageContext = getCareerStageContext(careerStage);
        
        // Build the enhanced summary prompt
        let summaryPrompt = `Write a compelling professional summary for a CV. Keep it concise, impactful, and 2-3 sentences maximum.

TALENT CONTEXT:
- Career Stage: ${careerStage} (${stageContext.description})
- Summary Tone: ${stageContext.tone}
- Focus Areas: ${stageContext.focus}
- Key Skills: ${keySkills.join(', ')}
- Has Work Experience: ${hasExperience}
- Has Projects: ${hasProjects}
- Has Certifications: ${hasCertifications}
- Has Education: ${hasEducation}`;

        // Add career path context if available
        if (careerPath) {
            summaryPrompt += `
- Target Career Field: ${careerPath.title}
- Industry: ${careerPath.industry}
- Required Skills for Path: ${careerPath.requiredSkills ? careerPath.requiredSkills.slice(0, 4).join(', ') : 'Not specified'}`;
        }

        summaryPrompt += `

WRITING REQUIREMENTS:
- Start with a strong professional identity statement
- Use active voice and confident language
- Mention 2-3 most relevant skills that align with the career path
- Include career aspirations that match the career stage context
- Keep under 60 words total
- Sound professional and authentic
- Don't mention specific companies, project names, or personal details
- Match the tone to the career stage (${stageContext.tone})

EXAMPLES BY CAREER STAGE:

Pathfinder Example:
"Motivated ${careerPath ? careerPath.title.toLowerCase() : 'professional'} with strong foundation in [key skills]. Eager to apply academic knowledge and hands-on project experience to contribute meaningfully while continuing to learn and grow in [field/industry]."

Trailblazer Example:
"Experienced ${careerPath ? careerPath.title.toLowerCase() : 'professional'} with proven expertise in [key skills]. Demonstrated ability to [relevant achievement] with a track record of delivering results and seeking opportunities for continued growth and leadership."

Horizon Changer Example:
"Adaptable professional transitioning into ${careerPath ? careerPath.title.toLowerCase() : 'new field'} with transferable skills in [relevant skills]. Bringing unique perspective from [previous experience] combined with fresh enthusiasm for [new field focus]."

Write a professional summary that matches the ${careerStage} career stage:`;

        const summaryResult = await model.generateContent(summaryPrompt);
        const professionalSummary = summaryResult.response.text().trim();

        log('Generating PDF...');
        // Generate PDF
        const pdfBuffer = await generatePDF({
            talent,
            careerPath,
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
                careerStage: careerStage,
                careerPath: careerPath ? careerPath.title : 'Not specified',
                generatedAt: new Date().toISOString(),
                sections: ['Personal Info', 'Professional Summary', 'Education', 'Work Experience', 'Projects', 'Skills', 'Certifications']
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

async function generatePDF({ talent, careerPath, combinedSkills, educationDetails, workExperiences, projects, certifications, contactInfo, professionalSummary }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ 
            margin: 40,
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
        const pageWidth = 515; // A4 width minus margins (595 - 40*2)
        const leftMargin = 40;

        // Helper function to check if we need a new page
        const checkPageBreak = (requiredSpace) => {
            if (yPosition + requiredSpace > 750) {
                doc.addPage();
                yPosition = 50;
            }
        };

        // Helper function to add section separator
        const addSectionSeparator = () => {
            yPosition += 15;
            doc.moveTo(leftMargin, yPosition)
               .lineTo(leftMargin + pageWidth, yPosition)
               .strokeColor('#cccccc')
               .lineWidth(0.5)
               .stroke();
            yPosition += 20;
        };

        // Header with Name - Times New Roman, larger size
        doc.font('Times-Bold')
           .fontSize(24)
           .fillColor('#000000')
           .text(talent.fullname.toUpperCase(), leftMargin, yPosition, { 
               align: 'center',
               width: pageWidth 
           });
        yPosition += 35;

        // Career Path subtitle (if available)
        if (careerPath) {
            doc.font('Times-Italic')
               .fontSize(14)
               .fillColor('#333333')
               .text(careerPath.title, leftMargin, yPosition, { 
                   align: 'center',
                   width: pageWidth 
               });
            yPosition += 25;
        }

        // Contact Information
        const contactParts = [];
        if (talent.email) contactParts.push(talent.email);
        if (contactInfo.phone) contactParts.push(contactInfo.phone);
        
        if (contactParts.length > 0) {
            const contactLine = contactParts.join(' | ');
            doc.font('Times-Roman')
               .fontSize(11)
               .fillColor('#333333')
               .text(contactLine, leftMargin, yPosition, { 
                   align: 'center',
                   width: pageWidth 
               });
            yPosition += 18;
        }

        // Professional links with clean text labels
        const availableLinks = [];
        if (contactInfo.linkedin) availableLinks.push({ text: 'LinkedIn', url: contactInfo.linkedin });
        if (contactInfo.github) availableLinks.push({ text: 'GitHub', url: contactInfo.github });
        if (contactInfo.portfolio) availableLinks.push({ text: 'Portfolio', url: contactInfo.portfolio });
        
        if (availableLinks.length > 0) {
            const linkSpacing = 80; // Reduced spacing since text is shorter
            const totalWidth = (availableLinks.length - 1) * linkSpacing;
            let startX = leftMargin + (pageWidth - totalWidth) / 2;
            
            doc.font('Times-Roman')
               .fontSize(10)
               .fillColor('#0066cc');
            
            availableLinks.forEach((link, index) => {
                doc.text(link.text, startX, yPosition, {
                    link: link.url,
                    underline: true,
                    continued: false
                });
                
                if (index < availableLinks.length - 1) {
                    startX += linkSpacing;
                }
            });
            yPosition += 18;
        }

        yPosition += 10;

        // Add horizontal line under header
        doc.moveTo(leftMargin, yPosition)
           .lineTo(leftMargin + pageWidth, yPosition)
           .strokeColor('#000000')
           .lineWidth(1)
           .stroke();
        yPosition += 25;

        // Professional Summary Section
        if (professionalSummary && professionalSummary.trim()) {
            checkPageBreak(80);
            
            doc.font('Times-Bold')
               .fontSize(14)
               .fillColor('#000000')
               .text('PROFESSIONAL SUMMARY', leftMargin, yPosition);
            yPosition += 20;
            
            doc.font('Times-Roman')
               .fontSize(12)
               .fillColor('#000000')
               .text(professionalSummary.trim(), leftMargin, yPosition, { 
                   width: pageWidth, 
                   align: 'justify',
                   lineGap: 2
               });
            yPosition += doc.heightOfString(professionalSummary.trim(), { 
                width: pageWidth, 
                lineGap: 2 
            }) + 10;
            
            addSectionSeparator();
        }

        // Education Section
        if (educationDetails && educationDetails.length > 0) {
            checkPageBreak(100);

            doc.font('Times-Bold')
               .fontSize(14)
               .fillColor('#000000')
               .text('EDUCATION', leftMargin, yPosition);
            yPosition += 20;

            educationDetails.forEach((edu, index) => {
                checkPageBreak(60);

                doc.font('Times-Bold')
                   .fontSize(12)
                   .fillColor('#000000')
                   .text(edu.degree, leftMargin, yPosition);
                yPosition += 16;
                
                let institutionText = edu.institution;
                if (edu.location) {
                    institutionText += ` • ${edu.location}`;
                }
                
                doc.font('Times-Italic')
                   .fontSize(11)
                   .fillColor('#333333')
                   .text(institutionText, leftMargin, yPosition);
                yPosition += 14;
                
                if (edu.startDate || edu.endDate) {
                    const dateRange = `${edu.startDate || ''} - ${edu.endDate || 'Present'}`;
                    doc.font('Times-Roman')
                       .fontSize(10)
                       .fillColor('#666666')
                       .text(dateRange, leftMargin, yPosition);
                    yPosition += 18;
                } else {
                    yPosition += 8;
                }
                
                if (index < educationDetails.length - 1) {
                    yPosition += 10;
                }
            });
            
            addSectionSeparator();
        }

        // Work Experience Section
        if (workExperiences && workExperiences.length > 0) {
            checkPageBreak(100);

            doc.font('Times-Bold')
               .fontSize(14)
               .fillColor('#000000')
               .text('WORK EXPERIENCE', leftMargin, yPosition);
            yPosition += 20;

            workExperiences.forEach((exp, index) => {
                checkPageBreak(80);

                doc.font('Times-Bold')
                   .fontSize(12)
                   .fillColor('#000000')
                   .text(exp.position, leftMargin, yPosition);
                yPosition += 16;
                
                let companyText = exp.company;
                if (exp.location) {
                    companyText += ` • ${exp.location}`;
                }
                
                doc.font('Times-Italic')
                   .fontSize(11)
                   .fillColor('#333333')
                   .text(companyText, leftMargin, yPosition);
                yPosition += 14;
                
                if (exp.startDate || exp.endDate) {
                    const dateRange = `${exp.startDate || ''} - ${exp.endDate || 'Present'}`;
                    doc.font('Times-Roman')
                       .fontSize(10)
                       .fillColor('#666666')
                       .text(dateRange, leftMargin, yPosition);
                    yPosition += 16;
                }
                
                if (exp.description && exp.description.trim()) {
                    doc.font('Times-Roman')
                       .fontSize(12)
                       .fillColor('#000000')
                       .text(exp.description.trim(), leftMargin, yPosition, { 
                           width: pageWidth, 
                           align: 'justify',
                           lineGap: 2
                       });
                    yPosition += doc.heightOfString(exp.description.trim(), { 
                        width: pageWidth, 
                        lineGap: 2 
                    }) + 10;
                }
                
                if (index < workExperiences.length - 1) {
                    yPosition += 15;
                }
            });
            
            addSectionSeparator();
        }

        // Projects Section
        if (projects && projects.length > 0) {
            checkPageBreak(100);

            doc.font('Times-Bold')
               .fontSize(14)
               .fillColor('#000000')
               .text('PROJECTS', leftMargin, yPosition);
            yPosition += 20;

            projects.forEach((project, index) => {
                checkPageBreak(80);

                if (project.link && project.link.trim()) {
                    doc.font('Times-Bold')
                       .fontSize(12)
                       .fillColor('#0066cc')
                       .text(project.title, leftMargin, yPosition, {
                           link: project.link.trim(),
                           underline: true
                       });
                } else {
                    doc.font('Times-Bold')
                       .fontSize(12)
                       .fillColor('#000000')
                       .text(project.title, leftMargin, yPosition);
                }
                yPosition += 16;
                
                if (project.description && project.description.trim()) {
                    doc.font('Times-Roman')
                       .fontSize(12)
                       .fillColor('#000000')
                       .text(project.description.trim(), leftMargin, yPosition, { 
                           width: pageWidth, 
                           align: 'justify',
                           lineGap: 2
                       });
                    yPosition += doc.heightOfString(project.description.trim(), { 
                        width: pageWidth, 
                        lineGap: 2 
                    }) + 10;
                }
                
                if (project.technologies && project.technologies.trim()) {
                    doc.font('Times-Bold')
                       .fontSize(11)
                       .fillColor('#000000')
                       .text('Technologies: ', leftMargin, yPosition, { continued: true });
                    
                    doc.font('Times-Roman')
                       .fontSize(11)
                       .fillColor('#333333')
                       .text(project.technologies.trim());
                    yPosition += 16;
                }

                if (project.details && Array.isArray(project.details) && project.details.length > 0) {
                    project.details.forEach((detail) => {
                        if (detail && detail.trim()) {
                            checkPageBreak(30);
                            doc.font('Times-Roman')
                               .fontSize(11)
                               .fillColor('#000000')
                               .text(`• ${detail.trim()}`, leftMargin + 15, yPosition, { 
                                   width: pageWidth - 15,
                                   lineGap: 1
                               });
                            yPosition += doc.heightOfString(`• ${detail.trim()}`, { 
                                width: pageWidth - 15,
                                lineGap: 1
                            }) + 5;
                        }
                    });
                }
                
                if (index < projects.length - 1) {
                    yPosition += 15;
                }
            });
            
            addSectionSeparator();
        }

        // Technical Skills Section
        if (combinedSkills && combinedSkills.length > 0) {
            checkPageBreak(60);

            doc.font('Times-Bold')
               .fontSize(14)
               .fillColor('#000000')
               .text('TECHNICAL SKILLS', leftMargin, yPosition);
            yPosition += 20;
            
            const skillsText = combinedSkills.join(' • ');
            doc.font('Times-Roman')
               .fontSize(12)
               .fillColor('#000000')
               .text(skillsText, leftMargin, yPosition, { 
                   width: pageWidth, 
                   align: 'justify',
                   lineGap: 2
               });
            yPosition += doc.heightOfString(skillsText, { 
                width: pageWidth, 
                lineGap: 2 
            }) + 10;
            
            addSectionSeparator();
        }

        // Certifications Section
        if (certifications && certifications.length > 0) {
            checkPageBreak(80);

            doc.font('Times-Bold')
               .fontSize(14)
               .fillColor('#000000')
               .text('CERTIFICATIONS & ACHIEVEMENTS', leftMargin, yPosition);
            yPosition += 20;

            certifications.forEach((cert, index) => {
                checkPageBreak(50);

                if (cert.link && cert.link.trim()) {
                    doc.font('Times-Bold')
                       .fontSize(12)
                       .fillColor('#0066cc')
                       .text(cert.title, leftMargin, yPosition, {
                           link: cert.link.trim(),
                           underline: true
                       });
                } else {
                    doc.font('Times-Bold')
                       .fontSize(12)
                       .fillColor('#000000')
                       .text(cert.title, leftMargin, yPosition);
                }
                yPosition += 16;
                
                let issuerText = cert.issuer;
                if (cert.date) {
                    issuerText += ` • ${cert.date}`;
                }
                
                doc.font('Times-Italic')
                   .fontSize(11)
                   .fillColor('#333333')
                   .text(issuerText, leftMargin, yPosition);
                yPosition += 14;
                
                if (index < certifications.length - 1) {
                    yPosition += 10;
                }
            });
            
            addSectionSeparator();
        }

        // Interests Section (if available)
        if (talent.interests && talent.interests.length > 0) {
            checkPageBreak(60);

            doc.font('Times-Bold')
               .fontSize(14)
               .fillColor('#000000')
               .text('INTERESTS', leftMargin, yPosition);
            yPosition += 20;
            
            const interestsText = talent.interests.join(' • ');
            doc.font('Times-Roman')
               .fontSize(12)
               .fillColor('#000000')
               .text(interestsText, leftMargin, yPosition, { 
                   width: pageWidth, 
                   align: 'justify',
                   lineGap: 2
               });
        }

        doc.end();
    });
}
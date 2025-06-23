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

        let yPosition = 60;
        const pageWidth = 545; // A4 width minus margins
        const leftMargin = 50;
        const rightMargin = 50;

        // Helper function to check if we need a new page
        const checkPageBreak = (requiredSpace) => {
            if (yPosition + requiredSpace > 750) {
                doc.addPage();
                yPosition = 60;
            }
        };

        // Helper function to add section separator
        const addSectionSeparator = () => {
            yPosition += 15;
            doc.moveTo(leftMargin, yPosition)
               .lineTo(pageWidth + leftMargin, yPosition)
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

        // Contact Information - More compact and professional
        const contactParts = [];
        if (talent.email) contactParts.push(talent.email);
        if (contactInfo.phone) contactParts.push(contactInfo.phone);
        
        // Add linked contact info with hidden URLs
        const linkedContacts = [];
        if (contactInfo.linkedin) linkedContacts.push(`LinkedIn: ${talent.fullname}`);
        if (contactInfo.github) linkedContacts.push('GitHub: Profile');
        if (contactInfo.portfolio) linkedContacts.push('Portfolio: Website');

        // Combine contact info
        const allContacts = [...contactParts, ...linkedContacts];
        
        if (allContacts.length > 0) {
            doc.font('Times-Roman')
               .fontSize(11)
               .fillColor('#333333')
               .text(allContacts.join(' | '), leftMargin, yPosition, { 
                   align: 'center',
                   width: pageWidth 
               });
            yPosition += 25;
        }

        // Add horizontal line under header
        doc.moveTo(leftMargin, yPosition)
           .lineTo(pageWidth + leftMargin, yPosition)
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

                // Degree name - bold
                doc.font('Times-Bold')
                   .fontSize(12)
                   .fillColor('#000000')
                   .text(edu.degree, leftMargin, yPosition);
                yPosition += 16;
                
                // Institution and location
                let institutionText = edu.institution;
                if (edu.location) {
                    institutionText += ` • ${edu.location}`;
                }
                
                doc.font('Times-Italic')
                   .fontSize(11)
                   .fillColor('#333333')
                   .text(institutionText, leftMargin, yPosition);
                yPosition += 14;
                
                // Date range
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
                
                // Add spacing between education entries
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

                // Position title - bold
                doc.font('Times-Bold')
                   .fontSize(12)
                   .fillColor('#000000')
                   .text(exp.position, leftMargin, yPosition);
                yPosition += 16;
                
                // Company and location
                let companyText = exp.company;
                if (exp.location) {
                    companyText += ` • ${exp.location}`;
                }
                
                doc.font('Times-Italic')
                   .fontSize(11)
                   .fillColor('#333333')
                   .text(companyText, leftMargin, yPosition);
                yPosition += 14;
                
                // Date range
                if (exp.startDate || exp.endDate) {
                    const dateRange = `${exp.startDate || ''} - ${exp.endDate || 'Present'}`;
                    doc.font('Times-Roman')
                       .fontSize(10)
                       .fillColor('#666666')
                       .text(dateRange, leftMargin, yPosition);
                    yPosition += 16;
                }
                
                // Job description
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
                
                // Add spacing between work experiences
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

                // Project title - bold
                doc.font('Times-Bold')
                   .fontSize(12)
                   .fillColor('#000000')
                   .text(project.title, leftMargin, yPosition);
                yPosition += 16;
                
                // Project description
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
                
                // Technologies used
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
                
                // Project link (hidden behind "Project Link" text)
                if (project.link && project.link.trim()) {
                    doc.font('Times-Roman')
                       .fontSize(11)
                       .fillColor('#0066cc')
                       .text('Project Link', leftMargin, yPosition, {
                           link: project.link.trim(),
                           underline: true
                       });
                    yPosition += 16;
                }

                // Project details/achievements
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
                
                // Add spacing between projects
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

                // Certification title - bold
                doc.font('Times-Bold')
                   .fontSize(12)
                   .fillColor('#000000')
                   .text(cert.title, leftMargin, yPosition);
                yPosition += 16;
                
                // Issuer and date
                let issuerText = cert.issuer;
                if (cert.date) {
                    issuerText += ` • ${cert.date}`;
                }
                
                doc.font('Times-Italic')
                   .fontSize(11)
                   .fillColor('#333333')
                   .text(issuerText, leftMargin, yPosition);
                yPosition += 14;
                
                // Certification link (hidden behind "Certificate" text)
                if (cert.link && cert.link.trim()) {
                    doc.font('Times-Roman')
                       .fontSize(11)
                       .fillColor('#0066cc')
                       .text('Certificate', leftMargin, yPosition, {
                           link: cert.link.trim(),
                           underline: true
                       });
                    yPosition += 16;
                }
                
                // Add spacing between certifications
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

        // Add clickable links for contact information if provided
        if (contactInfo.linkedin || contactInfo.github || contactInfo.portfolio) {
            // Go back to add actual links to the contact section
            // This requires repositioning, so we'll add a footer with links instead
            
            // Add footer with actual links
            const footerY = 750;
            doc.fontSize(9)
               .fillColor('#666666');
            
            let footerText = 'Links: ';
            const footerLinks = [];
            
            if (contactInfo.linkedin) {
                footerLinks.push('LinkedIn');
            }
            if (contactInfo.github) {
                footerLinks.push('GitHub');
            }
            if (contactInfo.portfolio) {
                footerLinks.push('Portfolio');
            }
            
            if (footerLinks.length > 0) {
                footerText += footerLinks.join(' | ');
                doc.text(footerText, leftMargin, footerY, { width: pageWidth });
                
                // Add actual clickable links
                let linkX = leftMargin + 35; // Start after "Links: "
                
                if (contactInfo.linkedin) {
                    doc.text('LinkedIn', linkX, footerY, {
                        link: contactInfo.linkedin,
                        underline: true
                    });
                    linkX += 50;
                }
                
                if (contactInfo.github) {
                    doc.text('GitHub', linkX, footerY, {
                        link: contactInfo.github,
                        underline: true
                    });
                    linkX += 45;
                }
                
                if (contactInfo.portfolio) {
                    doc.text('Portfolio', linkX, footerY, {
                        link: contactInfo.portfolio,
                        underline: true
                    });
                }
            }
        }

        doc.end();
    });
}